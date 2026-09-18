param()
$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
function Reply($value) { @{ ok = $true } + $value | ConvertTo-Json -Compress -Depth 8; exit 0 }
function Fail([string]$code = 'BRIDGE_FAILED') { @{ ok = $false; code = $code } | ConvertTo-Json -Compress; exit 2 }
try { $cfg = [Console]::In.ReadToEnd() | ConvertFrom-Json } catch { Fail }
try {
  Add-Type -AssemblyName System.Windows.Forms, UIAutomationClient, UIAutomationTypes -ErrorAction Stop
  Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices; using System.Threading;
public static class DshWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool join);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public delegate bool EnumCallback(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCallback f, IntPtr p);
  public static IntPtr[] Windows() { var hs = new System.Collections.Generic.List<IntPtr>(); EnumWindows((h,p) => { if (IsWindowVisible(h)) hs.Add(h); return true; }, IntPtr.Zero); return hs.ToArray(); }
  public static bool Focus(IntPtr h) { uint p; uint active = GetWindowThreadProcessId(GetForegroundWindow(), out p); uint current = GetCurrentThreadId(); bool attached = active != current && AttachThreadInput(current, active, true); try { if (IsIconic(h)) ShowWindow(h,9); SetForegroundWindow(h); return GetForegroundWindow() == h; } finally { if (attached) AttachThreadInput(current, active, false); } }
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  public struct RECT { public int Left,Top,Right,Bottom; }
  public static void Click(int x, int y) { SetCursorPos(x,y); mouse_event(2,0,0,0,UIntPtr.Zero); mouse_event(4,0,0,0,UIntPtr.Zero); }
}
public static class DshKeys {
  [StructLayout(LayoutKind.Sequential)] public struct KI { public ushort vk, scan; public uint flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct MI { public int x, y; public uint data, flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct IU { [FieldOffset(0)] public KI key; [FieldOffset(0)] public MI mouse; }
  [StructLayout(LayoutKind.Sequential)] public struct IN { public uint type; public IU value; }
  [StructLayout(LayoutKind.Sequential)] public struct GI { public uint size, flags; public IntPtr active, focus, capture, menu, move, caret; public DshWin.RECT caretRect; }
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, IN[] inputs, int size);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] public static extern short GetKeyState(int key);
  [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint thread);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr LoadKeyboardLayout(string id, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern short VkKeyScanEx(char c, IntPtr layout);
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint thread, ref GI info);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint message, UIntPtr w, IntPtr l, uint flags, uint timeout, out UIntPtr result);
  [DllImport("imm32.dll")] public static extern IntPtr ImmGetContext(IntPtr h);
  [DllImport("imm32.dll")] public static extern bool ImmSetOpenStatus(IntPtr c, bool open);
  [DllImport("imm32.dll")] public static extern bool ImmGetOpenStatus(IntPtr c);
  [DllImport("imm32.dll")] public static extern bool ImmSetConversionStatus(IntPtr c, uint conversion, uint sentence);
  [DllImport("imm32.dll")] public static extern bool ImmReleaseContext(IntPtr h, IntPtr c);
  static IN Key(ushort vk, ushort scan, uint flags) { return new IN { type=1, value=new IU { key=new KI { vk=vk, scan=scan, flags=flags } } }; }
  static void Send(IN[] inputs) { if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(IN))) != inputs.Length) throw new InvalidOperationException("Input was not fully accepted."); }
  static void Guard(IntPtr h) { if (DshWin.GetForegroundWindow()!=h) throw new InvalidOperationException("Focus changed."); }
  static void NoModifiers() { foreach(int k in new int[]{16,17,18,91,92}) if ((GetAsyncKeyState(k)&0x8000)!=0) throw new InvalidOperationException("A modifier is held."); }
  static IntPtr Prepare(IntPtr h, uint timeout) {
    Guard(h); NoModifiers(); uint p; uint thread=DshWin.GetWindowThreadProcessId(h,out p);
    GI info=new GI(); info.size=(uint)Marshal.SizeOf(typeof(GI));
    if (!GetGUIThreadInfo(thread,ref info) || info.focus==IntPtr.Zero) throw new InvalidOperationException("No focused input.");
    uint inputThread=DshWin.GetWindowThreadProcessId(info.focus,out p);
    IntPtr layout=LoadKeyboardLayout("00000409",0); if (layout==IntPtr.Zero) throw new InvalidOperationException("US layout unavailable.");
    UIntPtr result;
    if (SendMessageTimeout(info.focus,0x50,UIntPtr.Zero,layout,2,timeout,out result)==IntPtr.Zero) throw new InvalidOperationException("Layout change unavailable.");
    if ((GetKeyboardLayout(inputThread).ToInt64()&0xffff)!=0x0409) throw new InvalidOperationException("English layout not confirmed.");
    IntPtr context=ImmGetContext(info.focus);
    if (context!=IntPtr.Zero) { try { ImmSetOpenStatus(context,false); ImmSetConversionStatus(context,0,0); if (ImmGetOpenStatus(context)) throw new InvalidOperationException("IME remains open."); } finally { ImmReleaseContext(info.focus,context); } }
    Guard(h); return layout;
  }
  public static void Type(IntPtr h, string text, string mode, int interval, uint timeout) {
    IntPtr layout=Prepare(h,timeout);
    if (mode!="unicode" && mode!="keyboard") throw new InvalidOperationException("Unknown input mode.");
    if (mode=="keyboard") foreach(char c in text) { short key=VkKeyScanEx(c,layout); if(c<32 || c>126 || key==-1 || ((key>>8)&~1)!=0) throw new InvalidOperationException("Unsupported physical key."); }
    foreach(char c in text) {
      Guard(h); NoModifiers();
      if (mode=="unicode") Send(new IN[]{Key(0,c,4),Key(0,c,6)});
      else { short mapping=VkKeyScanEx(c,layout); ushort vk=(ushort)(mapping&255); bool shift=(mapping&0x100)!=0;
        if(vk>=65 && vk<=90 && (GetKeyState(20)&1)!=0) shift=!shift;
        try { Send(shift ? new IN[]{Key(16,0,0),Key(vk,0,0),Key(vk,0,2),Key(16,0,2)} : new IN[]{Key(vk,0,0),Key(vk,0,2)}); }
        finally { if(shift && (GetAsyncKeyState(16)&0x8000)!=0) Send(new IN[]{Key(16,0,2)}); }
      }
      if(interval>0) Thread.Sleep(interval);
    }
    Guard(h);
  }
  public static void Enter(IntPtr h) { Guard(h); NoModifiers(); Send(new IN[]{Key(13,0,0),Key(13,0,2)}); }
}
'@ -ErrorAction Stop
  Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class DshDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }' -ErrorAction Stop
  [DshDpi]::SetProcessDPIAware() | Out-Null
  function NativeChromeElement($item, $owner) {
    $cursor = $item
    for ($i = 0; $i -lt 40 -and $null -ne $cursor; $i++) {
      if ($cursor.Equals($owner)) { return $true }
      if ($cursor.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document) { return $false }
      $cursor = [System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($cursor)
    }
    return $false
  }
  function NativeControls($owner, $type) {
    $queue = New-Object 'System.Collections.Generic.Queue[System.Windows.Automation.AutomationElement]'
    $queue.Enqueue($owner); $visited = 0
    while ($queue.Count -gt 0 -and $visited -lt 4096) {
      $item = $queue.Dequeue(); $visited++
      if ($item.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document) { continue }
      if ($item.Current.ControlType -eq $type) { Write-Output $item; continue }
      $child = [System.Windows.Automation.TreeWalker]::RawViewWalker.GetFirstChild($item)
      while ($null -ne $child -and $queue.Count -lt 4096) {
        $queue.Enqueue($child)
        $child = [System.Windows.Automation.TreeWalker]::RawViewWalker.GetNextSibling($child)
      }
    }
  }
  function TargetMatches($handle) {
    try {
      $owner = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
      foreach ($edit in (NativeControls $owner ([System.Windows.Automation.ControlType]::Edit))) {
        if (-not (NativeChromeElement $edit $owner)) { continue }
        $current = $edit.Current
        if ($current.IsOffscreen -or ($current.AutomationId -notmatch '(?i)address|urlbar|omnibox' -and $current.Name -notmatch '^(Address and search bar|\u5730\u5740\u548c\u641c\u7d22\u680f|\u5730\u5740\u680f)$')) { continue }
        $pattern = $null
        if (-not $edit.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { continue }
        $value = ([string]$pattern.Current.Value).Trim()
        if ($value -notmatch '^https?://') { $value = $target.Scheme + '://' + $value }
        $actual = [Uri]$value
        if ([string]::Equals($actual.AbsoluteUri, $target.AbsoluteUri, [StringComparison]::Ordinal)) { return $true }
      }
    } catch { return $false }
    return $false
  }
  $target = $null
  if (-not [string]::IsNullOrEmpty([string]$cfg.targetUrl)) {
    $target = [Uri][string]$cfg.targetUrl
    if (-not $target.IsAbsoluteUri -or @('http','https') -notcontains $target.Scheme -or -not [string]::IsNullOrEmpty($target.UserInfo)) { Fail 'TARGET_MISMATCH' }
  }
  if ($cfg.action -eq 'focus-target') {
    if ($null -eq $target) { Fail 'TARGET_REQUIRED' }
    $allowed = @($cfg.browserProcesses | ForEach-Object { ([string]$_).ToLowerInvariant() })
    $found = $false; $attempts = 0; $browserCandidates = 0; $focusedWindows = 0
    foreach ($candidate in [DshWin]::Windows()) {
      $candidatePid = [uint32]0; [DshWin]::GetWindowThreadProcessId($candidate, [ref]$candidatePid) | Out-Null
      try { $candidateProcess = Get-Process -Id $candidatePid -ErrorAction Stop } catch { continue }
      if ($allowed -notcontains $candidateProcess.ProcessName.ToLowerInvariant()) { continue }
      if ($null -ne $cfg.expected -and (('0x{0:X}' -f $candidate.ToInt64()) -ne [string]$cfg.expected.hwnd -or [int]$candidatePid -ne [int]$cfg.expected.pid -or $candidateProcess.ProcessName -ne [string]$cfg.expected.processName)) { continue }
      $browserCandidates++
      if ([DshWin]::IsIconic($candidate)) { [DshWin]::ShowWindow($candidate, 9) | Out-Null }
      [DshWin]::Focus($candidate) | Out-Null
      if ([DshWin]::GetForegroundWindow() -ne $candidate) { continue }
      $focusedWindows++
      if (TargetMatches $candidate) { $found = $true; break }
      $owner = [System.Windows.Automation.AutomationElement]::FromHandle($candidate)
      foreach ($tab in (NativeControls $owner ([System.Windows.Automation.ControlType]::TabItem))) {
        if (-not (NativeChromeElement $tab $owner) -or -not $tab.Current.IsEnabled) { continue }
        $attempts++; if ($attempts -gt 64) { Fail 'TARGET_NOT_FOUND' }
        $selection = $null
        if (-not $tab.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selection)) { continue }
        $selection.Select()
        $deadline = [Diagnostics.Stopwatch]::StartNew()
        do {
          if (TargetMatches $candidate) { $found = $true; break }
          Start-Sleep -Milliseconds 40
        } while ($deadline.ElapsedMilliseconds -lt 400)
        if ($found) { break }
      }
      if ($found) { break }
    }
    if (-not $found) {
      if ($browserCandidates -gt 0 -and $focusedWindows -eq 0) { Fail 'FOCUS_FAILED' }
      Fail 'TARGET_NOT_FOUND'
    }
    if ([DshWin]::GetForegroundWindow() -ne $candidate) { Fail 'FOCUS_FAILED' }
  }
  $window = [DshWin]::GetForegroundWindow(); if ($window -eq [IntPtr]::Zero) { Fail }
  $windowPid = [uint32]0; [DshWin]::GetWindowThreadProcessId($window, [ref]$windowPid) | Out-Null
  $titleBuilder = New-Object Text.StringBuilder 4096; [DshWin]::GetWindowText($window, $titleBuilder, $titleBuilder.Capacity) | Out-Null
  $process = Get-Process -Id $windowPid -ErrorAction Stop
  $windowRect = New-Object DshWin+RECT; if (-not [DshWin]::GetWindowRect($window, [ref]$windowRect)) { Fail }
  $identity = @{ hwnd = ('0x{0:X}' -f $window.ToInt64()); pid = [int]$windowPid; processName = $process.ProcessName; title = $titleBuilder.ToString(); rect = @{ x = $windowRect.Left; y = $windowRect.Top; width = $windowRect.Right - $windowRect.Left; height = $windowRect.Bottom - $windowRect.Top } }
  function SameIdentity($expected) {
    if ($null -eq $expected) { return $false }
    return [string]$expected.hwnd -eq [string]$identity.hwnd -and [int]$expected.pid -eq [int]$identity.pid -and [string]$expected.processName -eq [string]$identity.processName -and [string]$expected.title -eq [string]$identity.title -and [int]$expected.rect.x -eq [int]$identity.rect.x -and [int]$expected.rect.y -eq [int]$identity.rect.y -and [int]$expected.rect.width -eq [int]$identity.rect.width -and [int]$expected.rect.height -eq [int]$identity.rect.height
  }
  if ($cfg.action -eq 'identity') {
    $allowed = @($cfg.browserProcesses | ForEach-Object { ([string]$_).ToLowerInvariant() }); if ($allowed -notcontains $process.ProcessName.ToLowerInvariant()) { Fail }
    if ($null -ne $target -and -not (TargetMatches $window)) { Fail 'TARGET_MISMATCH' }; Reply $identity
  }
  if ($cfg.action -eq 'focus-target') { if (-not (TargetMatches $window)) { Fail 'TARGET_MISMATCH' }; Reply $identity }
  if ($cfg.action -eq 'command-input' -or $cfg.action -eq 'command-submit') {
    if (-not (SameIdentity $cfg.expected)) { Fail 'FOCUS_FAILED' }
    if ($null -ne $target -and -not (TargetMatches $window)) { Fail 'TARGET_MISMATCH' }
    if ($cfg.action -eq 'command-input') {
      $r = $cfg.rect
      if ($null -eq $r -or $r.width -le 0 -or $r.height -le 0 -or $r.x -lt $windowRect.Left -or $r.y -lt $windowRect.Top -or ($r.x+$r.width) -gt $windowRect.Right -or ($r.y+$r.height) -gt $windowRect.Bottom) { Fail }
      $text = [string]$cfg.text; $mode = [string]$cfg.mode
      if ([string]::IsNullOrEmpty($text) -or $text -match '[\x00-\x1f\x7f]' -or @('unicode','keyboard') -notcontains $mode) { Fail }
      if ($mode -eq 'keyboard' -and $text -match '[^\x20-\x7e]') { Fail }
      $interval = [int]$cfg.typingIntervalMs
      if ($interval -lt 0 -or $interval -gt 1000) { Fail }
      [DshWin]::Click([int]($r.x+$r.width/2), [int]($r.y+$r.height/2))
      [DshKeys]::Type($window, $text, $mode, $interval, [uint32]$cfg.timeoutMs)
    } else { [DshKeys]::Enter($window) }
    Reply @{}
  }
  if ($cfg.action -eq 'clipboard-set') { [Windows.Forms.Clipboard]::SetText([string]$cfg.text); Reply @{} }
  if ($cfg.action -eq 'clipboard-clear') { [Windows.Forms.Clipboard]::Clear(); Reply @{} }
  if ($cfg.action -eq 'clipboard-read') { Reply @{ text = [Windows.Forms.Clipboard]::GetText() } }
  if ($cfg.action -eq 'backend-input' -or $cfg.action -eq 'backend-capture') {
    if ($null -ne $cfg.expected -and -not (SameIdentity $cfg.expected)) { Fail 'FOCUS_FAILED' }
    if ($null -ne $target -and -not (TargetMatches $window)) { Fail 'TARGET_MISMATCH' }
    if ($cfg.action -eq 'backend-capture' -and $null -ne $target) {
      $vb = [Windows.Forms.SystemInformation]::VirtualScreen
      $left = [Math]::Max($windowRect.Left, $vb.Left); $top = [Math]::Max($windowRect.Top, $vb.Top)
      $right = [Math]::Min($windowRect.Right, $vb.Right); $bottom = [Math]::Min($windowRect.Bottom, $vb.Bottom)
      if ($right -le $left -or $bottom -le $top) { Fail 'FOCUS_FAILED' }
      $region = @((($left-$vb.Left)/$vb.Width), (($top-$vb.Top)/$vb.Height), (($right-$vb.Left)/$vb.Width), (($bottom-$vb.Top)/$vb.Height))
      $cfg.capture | Add-Member -NotePropertyName region -NotePropertyValue $region
    }
    $backendRoot = Join-Path $PSScriptRoot '..\third-party\computer-user'
    $backend = if ($cfg.action -eq 'backend-input') { Join-Path $backendRoot 'input.ps1' } else { Join-Path $backendRoot 'capture.ps1' }
    if (-not (Test-Path -LiteralPath $backend -PathType Leaf)) { Fail }
    $backendPayload = if ($cfg.action -eq 'backend-input') { $cfg.input } else { $cfg.capture }
    $json = $backendPayload | ConvertTo-Json -Compress -Depth 8
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    & $backend -Json $encoded
    exit $LASTEXITCODE
  }
  if ($cfg.action -eq 'menu') {
    if ($null -ne $target -and -not (TargetMatches $window)) { Fail 'TARGET_MISMATCH' }
    if (-not (SameIdentity $cfg.expected)) { Fail }
    $wanted = if ($cfg.kind -eq 'copy') { @('Copy', [Regex]::Unescape('\u590d\u5236')) } elseif ($cfg.kind -eq 'paste') { @('Paste', [Regex]::Unescape('\u7c98\u8d34')) } else { @() }
    if ($wanted.Count -eq 0) { Fail }
    $owner = [System.Windows.Automation.AutomationElement]::FromHandle($window)
    $items = $owner.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($item in $items) {
      $current = $item.Current; $name = ([string]$current.Name).Trim() -replace '\s*\([^)]*\)$',''
      if ($wanted -contains $name -and -not $current.IsOffscreen -and $current.IsEnabled -and $current.ControlType -eq [System.Windows.Automation.ControlType]::MenuItem) {
        $bounds = $current.BoundingRectangle; $x = [int][Math]::Round($bounds.Left + $bounds.Width / 2); $y = [int][Math]::Round($bounds.Top + $bounds.Height / 2)
        if ($x -ge $identity.rect.x -and $y -ge $identity.rect.y -and $x -lt ($identity.rect.x + $identity.rect.width) -and $y -lt ($identity.rect.y + $identity.rect.height)) { [DshWin]::Click($x,$y); Reply @{} }
      }
    }
    Fail
  }
  Fail
} catch { Fail }
