import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const WIN_CRED_CSHARP = `
using System;
using System.Runtime.InteropServices;
using System.Text;

public class AntigravityWinCred {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CredWrite(ref CREDENTIAL userCredential, uint flags);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CredRead(string target, uint type, int reservedFlag, out IntPtr credentialPtr);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CredDelete(string target, uint type, int flags);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern void CredFree(IntPtr cred);

    public static bool WriteSecret(string target, string user, string secret) {
        byte[] byteArray = Encoding.UTF8.GetBytes(secret);
        CREDENTIAL cred = new CREDENTIAL();
        cred.Type = 1; // CRED_TYPE_GENERIC
        cred.TargetName = target;
        cred.UserName = user;
        cred.Persist = 2; // CRED_PERSIST_LOCAL_MACHINE
        cred.CredentialBlobSize = (uint)byteArray.Length;
        cred.CredentialBlob = Marshal.AllocHGlobal(byteArray.Length);
        Marshal.Copy(byteArray, 0, cred.CredentialBlob, byteArray.Length);
        try {
            return CredWrite(ref cred, 0);
        } finally {
            Marshal.FreeHGlobal(cred.CredentialBlob);
        }
    }

    public static string ReadSecret(string target) {
        IntPtr credPtr;
        if (!CredRead(target, 1, 0, out credPtr)) return "";
        try {
            CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(credPtr, typeof(CREDENTIAL));
            byte[] bytes = new byte[cred.CredentialBlobSize];
            Marshal.Copy(cred.CredentialBlob, bytes, 0, (int)cred.CredentialBlobSize);
            return Encoding.UTF8.GetString(bytes);
        } finally {
            CredFree(credPtr);
        }
    }

    public static bool DeleteSecret(string target) {
        return CredDelete(target, 1, 0);
    }
}
`;

const WIN_CRED_PS_HELPER = `
$ProgressPreference = 'SilentlyContinue'
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -TypeDefinition $payload.cs
if ($payload.op -eq 'write') {
  $raw = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload.secretB64))
  $ok = [AntigravityWinCred]::WriteSecret($payload.target, $payload.user, $raw)
  if (-not $ok) {
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "CredWrite failed with Win32 error $err"
  }
  Write-Output 'OK'
} elseif ($payload.op -eq 'read') {
  $val = [AntigravityWinCred]::ReadSecret($payload.target)
  if ($val) { Write-Output $val }
} elseif ($payload.op -eq 'delete') {
  [void][AntigravityWinCred]::DeleteSecret($payload.target)
  Write-Output 'OK'
}
`;

const DPAPI_PS_HELPER = `
$ProgressPreference = 'SilentlyContinue'
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Security
if ($payload.op -eq 'protect') {
  $plain = [Convert]::FromBase64String($payload.dataB64)
  $enc = [System.Security.Cryptography.ProtectedData]::Protect($plain, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  Write-Output ([Convert]::ToBase64String($enc))
} elseif ($payload.op -eq 'unprotect') {
  $enc = [Convert]::FromBase64String($payload.protectedB64)
  $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  Write-Output ([Text.Encoding]::UTF8.GetString($plain))
}
`;

const WIN_CRED_ENCODED = Buffer.from(WIN_CRED_PS_HELPER, 'utf16le').toString('base64');
const DPAPI_ENCODED = Buffer.from(DPAPI_PS_HELPER, 'utf16le').toString('base64');

function runPowerShellEncodedWithJsonStdin(encodedScript, payloadObj) {
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedScript],
    {
      input: JSON.stringify(payloadObj),
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  ).trim();
}

function winCredRead(target) {
  if (process.platform !== 'win32') return null;
  const out = runPowerShellEncodedWithJsonStdin(WIN_CRED_ENCODED, {
    op: 'read',
    cs: WIN_CRED_CSHARP,
    target,
  });
  return out || null;
}

function winCredWrite(target, user, secret) {
  if (process.platform !== 'win32') return false;
  // Pass secret via base64 over stdin (never on command line)
  const secretB64 = Buffer.from(secret, 'utf8').toString('base64');
  return (
    runPowerShellEncodedWithJsonStdin(WIN_CRED_ENCODED, {
      op: 'write',
      cs: WIN_CRED_CSHARP,
      target,
      user,
      secretB64,
    }) === 'OK'
  );
}

function winCredDelete(target) {
  if (process.platform !== 'win32') return false;
  return (
    runPowerShellEncodedWithJsonStdin(WIN_CRED_ENCODED, {
      op: 'delete',
      cs: WIN_CRED_CSHARP,
      target,
    }) === 'OK'
  );
}

function dpapiProtect(secretUtf8) {
  return runPowerShellEncodedWithJsonStdin(DPAPI_ENCODED, {
    op: 'protect',
    dataB64: Buffer.from(secretUtf8, 'utf8').toString('base64'),
  });
}

function dpapiUnprotect(protectedB64) {
  return runPowerShellEncodedWithJsonStdin(DPAPI_ENCODED, {
    op: 'unprotect',
    protectedB64: protectedB64.trim(),
  });
}

export function restrictWindowsFileAcl(filePath) {
  if (process.platform !== 'win32') return;
  try {
    const user = process.env.USERNAME || '';
    if (!user) return;
    execFileSync(
      'icacls',
      [filePath, '/inheritance:r', '/grant:r', `${user}:(R,W)`],
      { windowsHide: true, stdio: 'ignore' }
    );
  } catch {
    // Non-fatal if ACL restriction cannot run in restricted container
  }
}

export class MasterKeyStore {
  constructor(options = {}) {
    this.secretsDir = options.secretsDir;
    this.namespace = options.namespace || 'AntigravitySocialPublisher';
    this.mode = options.mode || (process.platform === 'win32' ? 'wincred' : 'file');
    this.memoryCache = new Map();
  }

  getMasterKey() {
    const hex = this.getOrCreateSecret('MasterKey', () => crypto.randomBytes(32).toString('hex'));
    const buf = Buffer.from(hex, 'hex');
    if (buf.length !== 32) {
      throw new Error('Stored master encryption key is corrupted or invalid length');
    }
    return buf;
  }

  getIpcSecret() {
    return this.getOrCreateSecret('IpcSecret', () => crypto.randomBytes(32).toString('hex'));
  }

  getOrCreateSecret(secretName, generator) {
    if (this.memoryCache.has(secretName)) {
      return this.memoryCache.get(secretName);
    }

    const target = `${this.namespace}:${secretName}`;
    let existing = this.#readSecret(secretName, target);
    if (existing) {
      this.memoryCache.set(secretName, existing);
      return existing;
    }

    const fresh = generator();
    this.#writeSecret(secretName, target, fresh);
    this.memoryCache.set(secretName, fresh);
    return fresh;
  }

  getStorageBackendInfo() {
    return {
      mode: this.mode,
      namespace: this.namespace,
      isolatedFromDatabase: true,
    };
  }

  deleteSecret(secretName) {
    this.memoryCache.delete(secretName);
    const target = `${this.namespace}:${secretName}`;
    if (this.mode === 'wincred') {
      try {
        winCredDelete(target);
      } catch {
        // Ignore missing
      }
    }
    if (this.secretsDir) {
      for (const suffix of ['.dpapi', '.key']) {
        const p = path.join(this.secretsDir, `${secretName}${suffix}`);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
    }
  }

  #readSecret(secretName, target) {
    if (this.mode === 'memory') {
      return this.memoryCache.get(secretName) || null;
    }

    if (this.mode === 'wincred') {
      try {
        const val = winCredRead(target);
        if (val) return val;
      } catch {
        // Fallback to DPAPI file below if WinCred unavailable
      }
      if (this.secretsDir) {
        const dpapiPath = path.join(this.secretsDir, `${secretName}.dpapi`);
        if (fs.existsSync(dpapiPath)) {
          const protectedB64 = fs.readFileSync(dpapiPath, 'utf8');
          return dpapiUnprotect(protectedB64);
        }
      }
      return null;
    }

    if (this.mode === 'dpapi' && this.secretsDir) {
      const dpapiPath = path.join(this.secretsDir, `${secretName}.dpapi`);
      if (fs.existsSync(dpapiPath)) {
        return dpapiUnprotect(fs.readFileSync(dpapiPath, 'utf8'));
      }
      return null;
    }

    if (this.secretsDir) {
      const keyPath = path.join(this.secretsDir, `${secretName}.key`);
      if (fs.existsSync(keyPath)) {
        return fs.readFileSync(keyPath, 'utf8').trim();
      }
    }
    return null;
  }

  #writeSecret(secretName, target, secretValue) {
    if (this.mode === 'memory') {
      this.memoryCache.set(secretName, secretValue);
      return;
    }

    if (this.mode === 'wincred') {
      let storedInWinCred = false;
      try {
        storedInWinCred = winCredWrite(target, 'antigravity-publisher', secretValue);
      } catch {
        storedInWinCred = false;
      }
      if (storedInWinCred) {
        return;
      }
      // Fallback to Windows DPAPI protected file outside database directory
      if (this.secretsDir) {
        fs.mkdirSync(this.secretsDir, { recursive: true });
        const dpapiPath = path.join(this.secretsDir, `${secretName}.dpapi`);
        fs.writeFileSync(dpapiPath, dpapiProtect(secretValue), { encoding: 'utf8', mode: 0o600 });
        restrictWindowsFileAcl(dpapiPath);
        return;
      }
      throw new Error('Failed to persist secret in Windows Credential Manager or DPAPI store');
    }

    if (this.mode === 'dpapi' && this.secretsDir) {
      fs.mkdirSync(this.secretsDir, { recursive: true });
      const dpapiPath = path.join(this.secretsDir, `${secretName}.dpapi`);
      fs.writeFileSync(dpapiPath, dpapiProtect(secretValue), { encoding: 'utf8', mode: 0o600 });
      restrictWindowsFileAcl(dpapiPath);
      return;
    }

    if (this.secretsDir) {
      fs.mkdirSync(this.secretsDir, { recursive: true });
      const keyPath = path.join(this.secretsDir, `${secretName}.key`);
      fs.writeFileSync(keyPath, secretValue, { encoding: 'utf8', mode: 0o600 });
      restrictWindowsFileAcl(keyPath);
      return;
    }

    throw new Error('No secret storage backend configured');
  }
}
