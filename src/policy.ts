import { createHash } from 'node:crypto';

export type Risk = 'R0' | 'R1' | 'R2' | 'R3' | 'R4';

export interface PolicyResult {
  normalized: string;
  risk: Risk;
  targets: string[];
  reason: string;
  hash: string;
}

interface Asset {
  environment: string;
  criticality: string;
}

interface Classification {
  risk: Risk;
  targets: string[];
  reason: string;
}

const R0_COMMANDS = new Set([
  'cat', 'cut', 'df', 'du', 'file', 'head', 'id', 'last', 'ls', 'ps',
  'pwd', 'stat', 'tail', 'uname', 'uptime', 'vmstat', 'who', 'which',
]);
const R1_COMMANDS = new Set(['dmesg', 'free', 'grep', 'journalctl', 'ss']);
const DESTRUCTIVE_COMMANDS = new Set([
  'cfdisk', 'dd', 'fdisk', 'mkfs', 'mkfs.ext4', 'mkfs.xfs', 'parted', 'poweroff',
  'reboot', 'rm', 'sfdisk', 'shutdown', 'truncate', 'wipefs',
]);
const SENSITIVE_PATH = /(?:^|\/)(?:\.env(?:\.|$)|\.ssh\/|id_(?:rsa|dsa|ecdsa|ed25519)|shadow|passwd|credentials?|secrets?|tokens?|private[_-]?keys?)(?:$|\/|\.)/iu;
const SAFE_FIND_FLAGS = new Set(['-name', '-type', '-maxdepth', '-mindepth', '-print', '-ls', '-delete']);
const SAFE_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  cat: new Set(['-n', '-b', '-E', '-T', '-v']),
  cut: new Set(['-b', '-c', '-d', '-f', '-s']),
  df: new Set(['-h', '-H', '-T', '-i', '-P']),
  du: new Set(['-h', '-H', '-s', '-d', '--max-depth']),
  file: new Set(['-b', '-L', '-h']),
  head: new Set(['-c', '-n', '-q', '-v']),
  ls: new Set(['-a', '-A', '-d', '-F', '-h', '-l', '-q', '-r', '-R', '-S', '-t', '-1']),
  ps: new Set(['-a', '-e', '-f', '-l', '-o', '-p', '-u', 'aux']),
  grep: new Set(['-E', '-F', '-H', '-h', '-i', '-n', '-q', '-r', '-s', '-v', '-w', '-x']),
  stat: new Set(['-c', '-f', '-L', '-t']),
  tail: new Set(['-c', '-n', '-q', '-v']),
  uname: new Set(['-a', '-m', '-n', '-o', '-p', '-r', '-s', '-v']),
  which: new Set(['-a']),
  dmesg: new Set(['-H', '-L', '-T', '-k', '-u', '-x']),
  free: new Set(['-b', '-h', '-k', '-m', '-g', '-t', '-w']),
  journalctl: new Set(['-b', '-k', '-n', '-o', '-p', '-u', '--no-pager', '--since', '--until']),
  ss: new Set(['-4', '-6', '-a', '-H', '-l', '-n', '-p', '-t', '-u', '-x']),
};

function quoteWord(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`;
}

function tokenize(command: string): string[][] {
  if (typeof command !== 'string' || command.length > 8192 || command.trim().length === 0 || /[\u0000-\u001f\u007f]/u.test(command)) {
    throw new Error('Unsupported shell syntax');
  }
  const segments: string[][] = [[]];
  let word = '';
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let started = false;
  const flush = (): void => {
    if (started) segments.at(-1)?.push(word);
    word = '';
    started = false;
  };
  for (const char of command.trim()) {
    if (escaped) {
      if (quote === '"' && !['"', '\\'].includes(char)) throw new Error('Unsupported shell escape');
      word += char;
      escaped = false;
      started = true;
    } else if (char === '\\' && quote !== "'") {
      escaped = true;
      started = true;
    } else if (quote) {
      if (char === quote) quote = undefined;
      else word += char;
      started = true;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/u.test(char)) {
      flush();
    } else if (char === '|') {
      flush();
      if (segments.at(-1)?.length === 0 || segments.length === 2) throw new Error('Only one non-empty pipeline is supported');
      segments.push([]);
    } else if (';&<>$`(){}'.includes(char)) {
      throw new Error('Unsupported shell syntax');
    } else {
      word += char;
      started = true;
    }
  }
  if (escaped || quote) throw new Error('Unsupported shell syntax');
  flush();
  if (segments.length > 2 || segments.some((segment) => segment.length === 0) || segments.flat().length > 128) throw new Error('Unsupported shell syntax');
  return segments;
}

function executableName(value: string): string {
  if (value.includes('/') || value.includes('\\') || !/^[A-Za-z0-9_.-]+$/u.test(value)) {
    throw new Error('Executable must be a bare allowlisted command');
  }
  if (value !== value.toLowerCase()) throw new Error('Executable must use its lowercase allowlisted name');
  return value;
}

function targetsOf(args: string[]): string[] {
  return args.filter((arg) => !arg.startsWith('-'));
}

function checkSafeOptions(command: string, args: string[]): void {
  const options = SAFE_OPTIONS[command];
  if (!options) {
    if (args.some((arg) => arg.startsWith('-'))) throw new Error(`Options are not allowlisted for ${command}`);
    return;
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('-')) continue;
    if (command === 'ps' && /^-[aefl]+$/u.test(arg)) continue;
    const option = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (!options.has(option)) throw new Error(`Unsupported option for ${command}: ${arg}`);
    if (['-c', '-d', '-f', '-n', '-o', '-p', '-b'].includes(option) && !arg.includes('=') && !args[index + 1]) {
      throw new Error(`Missing option value for ${command}: ${arg}`);
    }
  }
}

function classifyFind(args: string[]): Classification {
  const targets: string[] = [];
  let deletes = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-delete') {
      deletes = true;
      continue;
    }
    if (arg.startsWith('-')) {
      if (!SAFE_FIND_FLAGS.has(arg)) throw new Error(`Unsupported find expression: ${arg}`);
      if (['-name', '-type', '-maxdepth', '-mindepth'].includes(arg)) {
        const value = args[index + 1];
        if (!value || value.startsWith('-')) throw new Error(`Missing find expression value: ${arg}`);
        targets.push(value);
        index += 1;
      }
    } else {
      targets.push(arg);
    }
  }
  if (deletes) return { risk: 'R4', targets: targetsOf(args), reason: 'find deletion requires destructive approval' };
  if (targets.some((target) => SENSITIVE_PATH.test(target))) throw new Error('Sensitive file access is denied');
  return { risk: 'R0', targets, reason: 'Bounded read-only find expression' };
}

function classifyService(command: string, args: string[]): Classification | undefined {
  const serviceActions = new Map<string, Risk>([
    ['status', 'R0'], ['is-active', 'R0'], ['is-enabled', 'R0'], ['show', 'R0'],
    ['reload', 'R2'], ['restart', 'R2'], ['start', 'R2'], ['enable', 'R2'],
    ['disable', 'R3'], ['stop', 'R3'],
  ]);
  const action = command === 'systemctl' ? args[0] : args[1];
  if (!action) return undefined;
  const risk = serviceActions.get(action);
  if (!risk) throw new Error(`Unsupported service action: ${action}`);
  const target = command === 'systemctl' ? args[1] : args[0];
  if (!target || target.startsWith('-')) {
    throw new Error('Unsupported service command form');
  }
  const trailing = args.slice(2);
  if (command === 'service' && trailing.length > 0) throw new Error('Unsupported service command form');
  if (risk !== 'R0' && trailing.length > 0) throw new Error('Inspection options are not valid for changing service actions');
  for (let index = 0; index < trailing.length; index += 1) {
    const option = trailing[index];
    if (option === '--no-pager' || /^--lines=\d+$/u.test(option)) continue;
    if (option === '--lines' && /^\d+$/u.test(trailing[index + 1] ?? '')) {
      index += 1;
      continue;
    }
    throw new Error(`Unsupported systemctl inspection option: ${option}`);
  }
  return { risk, targets: [target], reason: risk === 'R0' ? 'Read-only service inspection' : `Service ${action} changes runtime state` };
}

function classifySegment(tokens: string[], asset: Asset): Classification {
  const command = executableName(tokens[0]);
  const args = tokens.slice(1);
  const targets = targetsOf(args);
  if (command === 'kubectl' && args[0] === 'get' && ['nodes', 'node', 'no'].includes(args[1])) {
    const options = args.slice(2);
    if (!(options.length === 0 || options.length === 2 && options[0] === '-o' && options[1] === 'wide'
      || options.length === 1 && options[0] === '--output=wide')) throw new Error('Only kubectl get nodes with optional wide output is supported; target/credential overrides and watch are denied.');
    return { risk: 'R0', targets: ['nodes'], reason: 'Read-only Kubernetes node listing using the existing remote kubeconfig' };
  }
  if (command === 'nginx' && args.length === 1 && args[0] === '-t') return { risk: 'R1', targets: [], reason: 'nginx configuration syntax check' };
  if (['awk', 'sed', 'curl', 'wget', 'mount', 'ip', 'top', 'printf', 'sh', 'bash', 'dash', 'zsh', 'env', 'exec', 'eval', 'xargs', 'sudo', 'su', 'base64'].includes(command)) {
    throw new Error(`Denied ambiguous command: ${command}`);
  }
  if (DESTRUCTIVE_COMMANDS.has(command)) return { risk: 'R4', targets, reason: `Destructive operation requires approval: ${command}` };
  if (command === 'docker' && (args[0] === 'rm' || args[0] === 'system' && args[1] === 'prune')) return { risk: 'R4', targets, reason: 'Destructive Docker operation requires approval' };
  if (command === 'kubectl' && args[0] === 'delete') return { risk: 'R4', targets, reason: 'Destructive Kubernetes operation requires approval' };
  if (command === 'helm' && args[0] === 'uninstall') return { risk: 'R4', targets, reason: 'Destructive Helm operation requires approval' };
  if (command === 'iptables' && args.length === 1 && args[0] === '-F') return { risk: 'R3', targets, reason: 'Network policy flush requires explicit approval' };
  if (command === 'nft' && args.length === 2 && args[0] === 'flush' && args[1] === 'ruleset') return { risk: 'R3', targets, reason: 'Network policy flush requires explicit approval' };
  if (command === 'find') return classifyFind(args);
  if (command === 'systemctl' || command === 'service') {
    const result = classifyService(command, args);
    if (result) return result;
  }
  if (R0_COMMANDS.has(command) || R1_COMMANDS.has(command)) {
    if (targets.some((target) => SENSITIVE_PATH.test(target))) throw new Error('Sensitive file access is denied');
    checkSafeOptions(command, args);
    const critical = /(?:prod|production)/iu.test(asset.environment) || /(?:high|critical)/iu.test(asset.criticality);
    return { risk: R1_COMMANDS.has(command) || critical && command === 'ps' ? 'R1' : 'R0', targets, reason: R1_COMMANDS.has(command) ? 'Allowlisted bounded diagnostic command' : 'Allowlisted read-only command' };
  }
  throw new Error(`Unknown executable denied: ${command}`);
}

/** Classifies a POSIX command without executing it; unsupported or unknown input throws. */
export function classify(command: string, asset: Asset): PolicyResult {
  const segments = tokenize(command);
  const normalized = segments.map((segment) => segment.map(quoteWord).join(' ')).join(' | ');
  const classifications = segments.map((segment) => classifySegment(segment, asset));
  const risk = classifications.reduce<Risk>((highest, item) => item.risk > highest ? item.risk : highest, 'R0');
  const targets = [...new Set(classifications.flatMap((item) => item.targets))];
  const reason = classifications.map((item) => item.reason).join('; ');
  const hash = createHash('sha256').update(normalized, 'utf8').digest('hex');
  return { normalized, risk, targets, reason, hash };
}
