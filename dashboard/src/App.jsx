import React, { useEffect, useState } from 'react';
import { apiRequest, getCsrfToken, setCsrfToken } from './api/client.js';

export default function App() {
  const [authState, setAuthState] = useState({ loading: true, authenticated: false, passcodeConfigured: false });
  const [passcodeInput, setPasscodeInput] = useState('');
  const [bootstrapInput, setBootstrapInput] = useState('');
  const [tab, setTab] = useState('accounts');
  const [banner, setBanner] = useState(null);

  const [accounts, setAccounts] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [settings, setSettings] = useState(null);
  const [setupStatus, setSetupStatus] = useState(null);
  const [r2Usage, setR2Usage] = useState(null);
  const [r2Busy, setR2Busy] = useState(false);

  const [connectLabel, setConnectLabel] = useState('');
  const [igLoginMode, setIgLoginMode] = useState('meta_unified_login');
  const [watchDirsText, setWatchDirsText] = useState('');
  const [draftEdits, setDraftEdits] = useState({});
  const [editingAccountId, setEditingAccountId] = useState(null);
  const [accountEditForm, setAccountEditForm] = useState({});

  const [credForm, setCredForm] = useState({
    ytClientId: '',
    ytClientSecret: '',
    igAppId: '',
    igAppSecret: '',
    igConfigId: '',
    igLoginMode: '',
    igRedirectUri: '',
    r2AccountId: '',
    r2Bucket: '',
    r2AccessKeyId: '',
    r2SecretAccessKey: '',
    r2Endpoint: '',
    r2MonthlyUploadLimitCount: '',
    r2MonthlyUploadLimitMb: '',
    r2UrlTtlSeconds: '',
    r2RetentionMinutes: '',
    aiProvider: '',
    geminiApiKey: '',
    openaiApiKey: '',
    anthropicApiKey: '',
    ollamaBaseUrl: '',
    ollamaModel: '',
    dashboardPasscode: '',
  });

  const notify = (type, text) => setBanner({ type, text });

  const loadAll = async () => {
    const [accData, histData, setData, setupData] = await Promise.all([
      apiRequest('GET', '/api/accounts'),
      apiRequest('GET', '/api/publish/history?limit=40'),
      apiRequest('GET', '/api/settings'),
      apiRequest('GET', '/api/setup/status'),
    ]);
    setAccounts(accData.accounts || []);
    setJobs(histData.jobs || []);
    setSettings(setData.settings || null);
    setWatchDirsText((setData.settings?.videoWatchDirs || []).join('\n'));
    setSetupStatus(setupData || null);
    setR2Usage(setupData?.r2Usage || null);
    if (setupData?.instagram?.loginMode) {
      setIgLoginMode(setupData.instagram.loginMode);
    }
  };

  const handleRefreshR2Usage = async (live = true) => {
    setR2Busy(true);
    try {
      const usage = await apiRequest('GET', `/api/storage/usage?live=${live ? 'true' : 'false'}`);
      setR2Usage(usage);
      if (live) {
        notify(
          usage.measurementReliable ? 'success' : 'error',
          usage.measurementReliable
            ? `Measured live R2 bucket usage: ${(Number(usage.measured?.totalBytes || 0) / (1024 * 1024)).toFixed(2)} MB.`
            : `Live R2 usage check failed (fail closed): ${usage.measurementError || 'Bucket not readable'}`
        );
      }
    } catch (err) {
      notify('error', err.message);
    } finally {
      setR2Busy(false);
    }
  };

  const handleRunR2Cleanup = async () => {
    setR2Busy(true);
    try {
      const res = await apiRequest('POST', '/api/storage/cleanup', {});
      setR2Usage(res.usage || null);
      notify(
        'success',
        `R2 cleanup sweep completed: ${res.cleanup?.cleaned || 0} abandoned/expired object(s) deleted, ${res.cleanup?.multipart?.aborted || 0} incomplete multipart upload(s) aborted.`
      );
    } catch (err) {
      notify('error', err.message);
    } finally {
      setR2Busy(false);
    }
  };

  useEffect(() => {
    (async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const bootstrapCode = params.get('bootstrap');
        if (bootstrapCode) {
          window.history.replaceState({}, document.title, window.location.pathname);
          const boot = await apiRequest('POST', '/api/auth/bootstrap', { bootstrapCode });
          setCsrfToken(boot.csrfToken);
          setAuthState({ loading: false, authenticated: true, passcodeConfigured: false });
          await loadAll();
          return;
        }

        const status = await apiRequest('GET', '/api/auth/status');
        if (status.authenticated && status.csrfToken) {
          setCsrfToken(status.csrfToken);
        }
        setAuthState({
          loading: false,
          authenticated: Boolean(status.authenticated && (status.csrfToken || getCsrfToken())),
          passcodeConfigured: status.passcodeConfigured,
        });
        if (status.authenticated && (status.csrfToken || getCsrfToken())) {
          await loadAll();
        }
      } catch (err) {
        setAuthState({ loading: false, authenticated: false, passcodeConfigured: false });
        notify('error', err.message);
      }
    })();
  }, []);

  // Poll live progress while any job is queued/running
  useEffect(() => {
    if (!authState.authenticated) return;
    const hasActive = jobs.some((j) => ['queued', 'running'].includes(j.status));
    if (!hasActive) return;
    const timer = setInterval(() => {
      apiRequest('GET', '/api/publish/history?limit=40')
        .then((d) => setJobs(d.jobs || []))
        .catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [authState.authenticated, jobs]);

  const handleLogin = async (e) => {
    e.preventDefault();
    try {
      const data = await apiRequest('POST', '/api/auth/login', { passcode: passcodeInput });
      setCsrfToken(data.csrfToken);
      setPasscodeInput('');
      setAuthState((prev) => ({ ...prev, authenticated: true }));
      await loadAll();
    } catch (err) {
      notify('error', err.message);
    }
  };

  const handleBootstrapManual = async (e) => {
    e.preventDefault();
    try {
      const data = await apiRequest('POST', '/api/auth/bootstrap', { bootstrapCode: bootstrapInput.trim() });
      setCsrfToken(data.csrfToken);
      setBootstrapInput('');
      setAuthState((prev) => ({ ...prev, authenticated: true }));
      await loadAll();
    } catch (err) {
      notify('error', err.message);
    }
  };

  const handleConnect = async (platform) => {
    try {
      const body = {
        ...(connectLabel.trim() ? { displayName: connectLabel.trim() } : {}),
        ...(platform === 'instagram' ? { igLoginMode } : {}),
      };
      const data = await apiRequest('POST', `/api/accounts/connect/${platform}`, body);
      setConnectLabel('');
      window.open(data.authorizationUrl, '_blank', 'noopener,noreferrer');
      notify('success', `Opened official ${platform} OAuth authorization page in a new tab.`);
    } catch (err) {
      notify('error', err.message);
    }
  };

  const handleAccountAction = async (action, account) => {
    try {
      if (action === 'refresh') {
        await apiRequest('POST', `/api/accounts/${account.id}/refresh`, {});
        notify('success', `Refreshed token for ${account.displayName}.`);
      } else if (action === 'status') {
        await apiRequest('GET', `/api/accounts/${account.id}/status?live=true`);
        notify('success', `Verified live connection for ${account.displayName}.`);
      } else if (action === 'reauthorize') {
        const data = await apiRequest('POST', `/api/accounts/${account.id}/reauthorize`, {});
        window.open(data.authorizationUrl, '_blank', 'noopener,noreferrer');
        notify('success', `Opened reauthorization flow for ${account.displayName}.`);
      } else if (action === 'disconnect') {
        await apiRequest('POST', `/api/accounts/${account.id}/disconnect`, {});
        notify('success', `Disconnected ${account.displayName} and cleared active tokens.`);
      } else if (action === 'delete') {
        await apiRequest('DELETE', `/api/accounts/${account.id}`);
        notify('success', `Deleted ${account.displayName} and wiped encrypted credentials.`);
      }
      await loadAll();
    } catch (err) {
      notify('error', err.message);
    }
  };

  const startEditAccount = (acc) => {
    if (editingAccountId === acc.id) {
      setEditingAccountId(null);
      return;
    }
    setEditingAccountId(acc.id);
    setAccountEditForm({
      displayName: acc.displayName || '',
      defaultPrivacyStatus: acc.preferences?.defaultPrivacyStatus || 'private',
      autoDetectShorts: acc.preferences?.autoDetectShorts ?? true,
      defaultInstagramVisibility: acc.preferences?.defaultInstagramVisibility || 'public',
      shareToFeed: acc.preferences?.shareToFeed ?? true,
      tone: acc.preferences?.tone || '',
    });
  };

  const handleSaveAccountPrefs = async (e, acc) => {
    e.preventDefault();
    try {
      await apiRequest('PATCH', `/api/accounts/${acc.id}`, {
        displayName: accountEditForm.displayName.trim(),
        preferences: {
          ...(acc.platform === 'youtube'
            ? {
                defaultPrivacyStatus: accountEditForm.defaultPrivacyStatus,
                autoDetectShorts: Boolean(accountEditForm.autoDetectShorts),
              }
            : {
                defaultInstagramVisibility: accountEditForm.defaultInstagramVisibility || 'public',
                shareToFeed: Boolean(accountEditForm.shareToFeed),
              }),
          ...(accountEditForm.tone.trim() ? { tone: accountEditForm.tone.trim() } : {}),
        },
      });
      setEditingAccountId(null);
      notify('success', `Updated preferences for ${accountEditForm.displayName.trim()}.`);
      await loadAll();
    } catch (err) {
      notify('error', err.message);
    }
  };

  const handleApproveJob = async (job) => {
    try {
      const itemOverrides = {};
      for (const item of job.items) {
        if (draftEdits[item.id]) {
          itemOverrides[item.id] = draftEdits[item.id];
        }
      }
      await apiRequest('POST', `/api/publish/${job.id}/approve`, { itemOverrides, waitForCompletion: false });
      notify('success', `Approved job ${job.id}; publishing started.`);
      await loadAll();
    } catch (err) {
      notify('error', err.message);
    }
  };

  const handleRetryJob = async (jobId) => {
    try {
      await apiRequest('POST', `/api/publish/${jobId}/retry`, { waitForCompletion: false });
      notify('success', `Retrying failed destination(s) for job ${jobId}.`);
      await loadAll();
    } catch (err) {
      notify('error', err.message);
    }
  };

  const handleCancelJob = async (jobId) => {
    try {
      await apiRequest('POST', `/api/publish/${jobId}/cancel`, {});
      notify('success', `Cancelled job ${jobId}.`);
      await loadAll();
    } catch (err) {
      notify('error', err.message);
    }
  };

  const handleSaveSettings = async (e) => {
    e.preventDefault();
    try {
      const dirs = watchDirsText
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      const updated = await apiRequest('POST', '/api/settings', {
        publishMode: settings.publishMode,
        defaultAccountIds: settings.defaultAccountIds,
        defaultPrivacyStatus: settings.defaultPrivacyStatus,
        autoDetectShorts: settings.autoDetectShorts,
        videoWatchDirs: dirs,
      });
      setSettings(updated.settings);
      notify('success', 'Publishing settings saved.');
    } catch (err) {
      notify('error', err.message);
    }
  };

  const handleSaveCredentials = async (e) => {
    e.preventDefault();
    try {
      const tokenRegex = /^(?:EAA|EAAB|EAAG|IGAA|IGAAR|IGQ)[A-Za-z0-9._-]{20,}$/;
      if (tokenRegex.test(credForm.igAppId.trim()) || tokenRegex.test(credForm.igAppSecret.trim())) {
        notify(
          'error',
          'Do not paste a generated access token into Meta App ID or App Secret. Use the App ID & App Secret from Meta App Dashboard -> App settings -> Basic.'
        );
        return;
      }

      const payload = {};
      if (credForm.ytClientId || credForm.ytClientSecret) {
        payload.youtube = {
          ...(credForm.ytClientId ? { clientId: credForm.ytClientId.trim() } : {}),
          ...(credForm.ytClientSecret ? { clientSecret: credForm.ytClientSecret.trim() } : {}),
        };
      }
      if (
        credForm.igAppId ||
        credForm.igAppSecret ||
        credForm.igConfigId.trim() ||
        credForm.igLoginMode ||
        credForm.igRedirectUri.trim()
      ) {
        payload.instagram = {
          ...(credForm.igAppId ? { appId: credForm.igAppId.trim() } : {}),
          ...(credForm.igAppSecret ? { appSecret: credForm.igAppSecret.trim() } : {}),
          ...(credForm.igConfigId.trim() ? { configId: credForm.igConfigId.trim() } : {}),
          loginMode: credForm.igLoginMode || setupStatus?.instagram?.loginMode || 'meta_unified_login',
          ...(credForm.igRedirectUri.trim() ? { redirectUri: credForm.igRedirectUri.trim() } : {}),
        };
      }
      if (
        credForm.r2AccountId ||
        credForm.r2Bucket ||
        credForm.r2AccessKeyId ||
        credForm.r2SecretAccessKey ||
        credForm.r2Endpoint ||
        credForm.r2MonthlyUploadLimitCount ||
        credForm.r2MonthlyUploadLimitMb ||
        credForm.r2UrlTtlSeconds ||
        credForm.r2RetentionMinutes
      ) {
        payload.storage = {
          ...(credForm.r2AccountId || credForm.r2Endpoint
            ? { provider: credForm.r2Endpoint && !credForm.r2AccountId ? 's3' : 'r2' }
            : {}),
          ...(credForm.r2AccountId ? { accountId: credForm.r2AccountId.trim() } : {}),
          ...(credForm.r2Bucket ? { bucket: credForm.r2Bucket.trim() } : {}),
          ...(credForm.r2AccessKeyId ? { accessKeyId: credForm.r2AccessKeyId.trim() } : {}),
          ...(credForm.r2SecretAccessKey ? { secretAccessKey: credForm.r2SecretAccessKey.trim() } : {}),
          ...(credForm.r2Endpoint ? { endpoint: credForm.r2Endpoint.trim() } : {}),
          ...(credForm.r2MonthlyUploadLimitCount
            ? { monthlyUploadLimitCount: Number.parseInt(credForm.r2MonthlyUploadLimitCount, 10) }
            : {}),
          ...(credForm.r2MonthlyUploadLimitMb
            ? { monthlyUploadLimitMb: Number.parseInt(credForm.r2MonthlyUploadLimitMb, 10) }
            : {}),
          ...(credForm.r2UrlTtlSeconds
            ? { urlTtlSeconds: Number.parseInt(credForm.r2UrlTtlSeconds, 10) }
            : {}),
          ...(credForm.r2RetentionMinutes
            ? { retentionMinutes: Number.parseInt(credForm.r2RetentionMinutes, 10) }
            : {}),
        };
      }
      if (
        credForm.aiProvider ||
        credForm.geminiApiKey ||
        credForm.openaiApiKey ||
        credForm.anthropicApiKey ||
        credForm.ollamaBaseUrl ||
        credForm.ollamaModel
      ) {
        payload.ai = {
          ...(credForm.aiProvider ? { provider: credForm.aiProvider } : {}),
          ...(credForm.geminiApiKey ? { geminiApiKey: credForm.geminiApiKey.trim() } : {}),
          ...(credForm.openaiApiKey ? { openaiApiKey: credForm.openaiApiKey.trim() } : {}),
          ...(credForm.anthropicApiKey ? { anthropicApiKey: credForm.anthropicApiKey.trim() } : {}),
          ...(credForm.ollamaBaseUrl ? { ollamaBaseUrl: credForm.ollamaBaseUrl.trim() } : {}),
          ...(credForm.ollamaModel ? { ollamaModel: credForm.ollamaModel.trim() } : {}),
        };
      }
      if (credForm.dashboardPasscode) {
        payload.dashboardPasscode = credForm.dashboardPasscode;
      }

      const nextStatus = await apiRequest('POST', '/api/setup/credentials', payload);
      setSetupStatus(nextStatus);
      if (nextStatus?.r2Usage) {
        setR2Usage(nextStatus.r2Usage);
      }
      setCredForm((prev) => ({
        ...prev,
        ytClientId: '',
        ytClientSecret: '',
        igAppId: '',
        igAppSecret: '',
        igConfigId: '',
        igLoginMode: '',
        igRedirectUri: '',
        r2AccountId: '',
        r2Bucket: '',
        r2AccessKeyId: '',
        r2SecretAccessKey: '',
        r2Endpoint: '',
        r2MonthlyUploadLimitCount: '',
        r2MonthlyUploadLimitMb: '',
        r2UrlTtlSeconds: '',
        r2RetentionMinutes: '',
        aiProvider: '',
        geminiApiKey: '',
        openaiApiKey: '',
        anthropicApiKey: '',
        ollamaBaseUrl: '',
        ollamaModel: '',
        dashboardPasscode: '',
      }));
      notify('success', 'Credentials encrypted and saved locally. Values are masked and never returned to the browser.');
      if (nextStatus?.instagram?.loginMode) {
        setIgLoginMode(nextStatus.instagram.loginMode);
      }
    } catch (err) {
      notify('error', err.message);
    }
  };

  const handleResetIgRedirectUri = async () => {
    try {
      const nextStatus = await apiRequest('POST', '/api/setup/credentials', {
        instagram: { redirectUri: '' },
      });
      setSetupStatus(nextStatus);
      setCredForm((prev) => ({ ...prev, igRedirectUri: '' }));
      notify('success', 'Reset Instagram Redirect URI back to default local loopback.');
    } catch (err) {
      notify('error', err.message);
    }
  };

  const handleClearIgConfigId = async () => {
    try {
      const nextStatus = await apiRequest('POST', '/api/setup/credentials', {
        instagram: { configId: '' },
      });
      setSetupStatus(nextStatus);
      setCredForm((prev) => ({ ...prev, igConfigId: '' }));
      notify('success', 'Cleared Meta Unified Login Configuration ID.');
    } catch (err) {
      notify('error', err.message);
    }
  };

  const formatIgModeLabel = (mode) => {
    if (mode === 'meta_unified_login') return 'Meta Unified Login';
    if (mode === 'facebook_login') return 'Facebook Login (Legacy)';
    if (mode === 'instagram_login') return 'Instagram Login (Legacy)';
    return mode || 'Meta Unified Login';
  };

  const formatBytes = (bytes) => {
    if (bytes === null || bytes === undefined) return 'Not measured yet';
    const b = Number(bytes);
    if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`;
    if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(2)} MB`;
    if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${b} B`;
  };

  const formatMetricValue = (m) => {
    if (!m) return '—';
    if (m.unit === 'bytes') {
      return `${m.used === null ? 'Unknown (Fail Closed)' : formatBytes(m.used)} / ${formatBytes(m.limit)}`;
    }
    return `${m.used ?? 0} / ${m.limit} ${m.unit}`;
  };

  const progressFillClass = (threshold) => {
    if (threshold >= 95) return 'progress-fill warn-95';
    if (threshold >= 85) return 'progress-fill warn-85';
    if (threshold >= 70) return 'progress-fill warn-70';
    return 'progress-fill';
  };

  if (authState.loading) {
    return <div className="app-shell"><p className="muted">Loading local console...</p></div>;
  }

  if (!authState.authenticated || !getCsrfToken()) {
    return (
      <div className="app-shell" style={{ maxWidth: 520, marginTop: 48 }}>
        <div className="card">
          <h2>AI Social Media Publisher — Local Unlock</h2>
          <p className="muted">
            Restricted to <code>127.0.0.1</code>.{' '}
            {authState.passcodeConfigured
              ? 'Enter your dashboard passcode, or run npm run dashboard in your local terminal for a single-use launch code.'
              : 'Run npm run dashboard in a local terminal (inside the project folder) to open an unlocked tab or print a Single-Use Launch Code to paste below.'}
          </p>
          {banner && <div className={`alert ${banner.type}`}>{banner.text}</div>}
          {authState.passcodeConfigured && (
            <form onSubmit={handleLogin}>
              <label>Dashboard Passcode</label>
              <input
                type="password"
                value={passcodeInput}
                onChange={(e) => setPasscodeInput(e.target.value)}
                placeholder="Enter dashboard passcode"
              />
              <button className="btn primary" style={{ marginTop: 12 }} type="submit">Unlock Dashboard</button>
            </form>
          )}
          <form onSubmit={handleBootstrapManual} style={{ marginTop: 18 }}>
            <label>Or Single-Use Launch Code</label>
            <input
              type="password"
              value={bootstrapInput}
              onChange={(e) => setBootstrapInput(e.target.value)}
              placeholder="Paste bootstrap code from terminal"
            />
            <button className="btn" style={{ marginTop: 12 }} type="submit">Authenticate with Launch Code</button>
          </form>
        </div>
      </div>
    );
  }

  const awaitingJobs = jobs.filter((j) => j.status === 'awaiting_approval');
  const failedJobs = jobs.filter((j) => j.status === 'failed' || j.status === 'partial_success');
  const r2Warnings = r2Usage?.evaluation?.warnings || [];

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <h1>AI Social Media Publisher</h1>
          <p>Local Loopback Console (127.0.0.1) — Multi-Account YouTube &amp; Instagram</p>
        </div>
        <div className="row">
          <span className="badge connected">Mode: {settings?.publishMode || 'review'}</span>
          <button className="btn" onClick={() => loadAll().catch((e) => notify('error', e.message))}>Refresh</button>
        </div>
      </header>

      {banner && (
        <div className={`alert ${banner.type} between`}>
          <span>{banner.text}</span>
          <button className="btn" onClick={() => setBanner(null)}>Dismiss</button>
        </div>
      )}

      {r2Warnings.length > 0 && (
        <div className={`alert ${r2Usage?.evaluation?.anyBlocked || r2Usage?.evaluation?.highestThreshold >= 95 ? 'error' : 'warning'} between`}>
          <div>
            <strong>Cloudflare R2 Cost Protection Alert ({r2Usage?.evaluation?.highestThreshold}%+):</strong>{' '}
            {r2Warnings.map((w) => w.message).join(' | ')}
          </div>
          <button className="btn" onClick={() => setTab('r2')}>View R2 Usage</button>
        </div>
      )}

      <nav className="tabs">
        <button className={`tab-btn ${tab === 'accounts' ? 'active' : ''}`} onClick={() => setTab('accounts')}>
          Accounts ({accounts.length})
        </button>
        <button className={`tab-btn ${tab === 'history' ? 'active' : ''}`} onClick={() => setTab('history')}>
          Publishing &amp; Queue ({awaitingJobs.length} pending / {failedJobs.length} attention)
        </button>
        <button className={`tab-btn ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')}>
          Settings
        </button>
        <button className={`tab-btn ${tab === 'r2' ? 'active' : ''}`} onClick={() => setTab('r2')}>
          R2 Cost Guard {r2Warnings.length > 0 ? `(${r2Warnings.length} warn)` : ''}
        </button>
        <button className={`tab-btn ${tab === 'setup' ? 'active' : ''}`} onClick={() => setTab('setup')}>
          Setup &amp; Credentials
        </button>
      </nav>

      {tab === 'accounts' && (
        <>
          <div className="card">
            <div className="card-header">
              <h2>Connect New Social Account (Official OAuth 2.0)</h2>
            </div>
            <div className="grid-2">
              <div>
                <label>Account Label (e.g. AI News, Gaming News, Personal)</label>
                <input
                  value={connectLabel}
                  onChange={(e) => setConnectLabel(e.target.value)}
                  placeholder="Optional friendly label"
                />
              </div>
              <div>
                <label>Instagram OAuth Flow</label>
                <select value={igLoginMode} onChange={(e) => setIgLoginMode(e.target.value)}>
                  <option value="meta_unified_login">Meta Unified Login (Business Config ID)</option>
                  <option value="facebook_login">Facebook Login for Business (Legacy Page-linked IG)</option>
                  <option value="instagram_login">Instagram Login for Business/Creator (Legacy Standalone)</option>
                </select>
                {igLoginMode === 'meta_unified_login' && (
                  <p className="muted" style={{ margin: '6px 0 0', fontSize: '0.78rem' }}>
                    Config ID: <code>{setupStatus?.instagram?.configId || 'Not set'}</code> • Redirect:{' '}
                    <code>{String(setupStatus?.instagram?.redirectUri || '').startsWith('https://') ? 'HTTPS ready' : 'Needs HTTPS tunnel'}</code>
                  </p>
                )}
              </div>
            </div>
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn primary" onClick={() => handleConnect('youtube')}>
                + Connect YouTube Channel
              </button>
              <button className="btn primary" onClick={() => handleConnect('instagram')}>
                + Connect Instagram Professional Account
              </button>
            </div>
          </div>

          <div className="grid-2">
            {accounts.length === 0 ? (
              <div className="card"><p className="muted">No accounts connected yet. Configure OAuth credentials in Setup &amp; Credentials, then connect accounts above.</p></div>
            ) : (
              accounts.map((acc) => (
                <div className="account-card" key={acc.id}>
                  <div className="between">
                    <div>
                      <strong>{acc.displayName}</strong>{' '}
                      <span className={`badge platform-${acc.platform}`}>{acc.platform}</span>
                    </div>
                    <span className={`badge ${acc.connectionStatus}`}>{acc.connectionStatus}</span>
                  </div>
                  <p className="muted" style={{ margin: '6px 0' }}>
                    {acc.username || acc.platformAccountId} • ID: <code>{acc.id}</code>
                    {acc.platform === 'instagram' && acc.metadata?.loginMode
                      ? ` • ${formatIgModeLabel(acc.metadata.loginMode)}`
                      : ''}
                  </p>
                  {acc.scopes?.length > 0 && (
                    <p className="muted" style={{ margin: '4px 0', fontSize: '0.78rem' }}>
                      Permissions: {acc.scopes.join(', ')}
                    </p>
                  )}
                  {acc.tokenExpiresAt && (
                    <p className="muted" style={{ margin: '4px 0' }}>
                      Token expires: {new Date(acc.tokenExpiresAt).toLocaleString()}
                    </p>
                  )}
                  {acc.lastErrorMessage && (
                    <p style={{ color: '#fca5a5', fontSize: '0.82rem' }}>{acc.lastErrorMessage}</p>
                  )}
                  <div className="row" style={{ marginTop: 10 }}>
                    <button className="btn" onClick={() => handleAccountAction('status', acc)}>Check Status</button>
                    <button className="btn" onClick={() => handleAccountAction('refresh', acc)}>Refresh Token</button>
                    <button className="btn" onClick={() => startEditAccount(acc)}>
                      {editingAccountId === acc.id ? 'Close Edit' : 'Preferences'}
                    </button>
                    <button className="btn" onClick={() => handleAccountAction('reauthorize', acc)}>Reauthorize</button>
                    <button className="btn" onClick={() => handleAccountAction('disconnect', acc)}>Disconnect</button>
                    <button className="btn danger" onClick={() => handleAccountAction('delete', acc)}>Delete</button>
                  </div>
                  {editingAccountId === acc.id && (
                    <form onSubmit={(e) => handleSaveAccountPrefs(e, acc)} style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                      <label>Display Name</label>
                      <input
                        value={accountEditForm.displayName || ''}
                        onChange={(e) => setAccountEditForm({ ...accountEditForm, displayName: e.target.value })}
                        required
                      />
                      {acc.platform === 'youtube' ? (
                        <>
                          <label>Default Privacy</label>
                          <select
                            value={accountEditForm.defaultPrivacyStatus || 'private'}
                            onChange={(e) => setAccountEditForm({ ...accountEditForm, defaultPrivacyStatus: e.target.value })}
                          >
                            <option value="private">Private</option>
                            <option value="unlisted">Unlisted</option>
                            <option value="public">Public</option>
                          </select>
                          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                            <input
                              type="checkbox"
                              style={{ width: 'auto' }}
                              checked={Boolean(accountEditForm.autoDetectShorts)}
                              onChange={(e) => setAccountEditForm({ ...accountEditForm, autoDetectShorts: e.target.checked })}
                            />
                            Auto-detect vertical 9:16 videos as YouTube Shorts
                          </label>
                        </>
                      ) : (
                        <>
                          <label>Default Instagram Visibility</label>
                          <select
                            value={accountEditForm.defaultInstagramVisibility || 'public'}
                            onChange={(e) =>
                              setAccountEditForm({ ...accountEditForm, defaultInstagramVisibility: e.target.value })
                            }
                          >
                            <option value="public">Public (Feed + Reels, or Private IG followers)</option>
                            <option value="reels_only">Reels Tab Only (hidden from main profile grid)</option>
                            <option value="trial_manual">Trial Reel (hidden from profile &amp; followers until promoted)</option>
                            <option value="private">Private IG Creator Account (requires confirmation)</option>
                          </select>
                          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                            <input
                              type="checkbox"
                              style={{ width: 'auto' }}
                              checked={Boolean(accountEditForm.shareToFeed)}
                              onChange={(e) => setAccountEditForm({ ...accountEditForm, shareToFeed: e.target.checked })}
                            />
                            Share Reels to Instagram main feed by default
                          </label>
                        </>
                      )}
                      <label>Brand / Caption Tone (optional)</label>
                      <input
                        value={accountEditForm.tone || ''}
                        onChange={(e) => setAccountEditForm({ ...accountEditForm, tone: e.target.value })}
                        placeholder="e.g. concise developer explainer"
                      />
                      <button className="btn primary" style={{ marginTop: 10 }} type="submit">Save Preferences</button>
                    </form>
                  )}
                </div>
              ))
            )}
          </div>
        </>
      )}

      {tab === 'history' && (
        <div className="card">
          <div className="card-header">
            <h2>Review Queue &amp; Publishing History</h2>
          </div>
          {jobs.length === 0 ? (
            <p className="muted">No publishing jobs yet.</p>
          ) : (
            jobs.map((job) => (
              <div className="job-card" key={job.id} style={{ marginBottom: 14 }}>
                <div className="between">
                  <div>
                    <strong>{job.fileName || job.summary?.videoFileName || job.videoId}</strong>{' '}
                    <span className={`badge ${job.status}`}>{job.status}</span>
                  </div>
                  <span className="muted">
                    {new Date(job.createdAt).toLocaleString()} • Mode: {job.mode} • ID: <code>{job.id}</code>
                  </span>
                </div>
                {job.summary?.contentSummary && (
                  <p className="muted" style={{ margin: '6px 0' }}>{job.summary.contentSummary}</p>
                )}

                {job.items.map((item) => {
                  const editState = draftEdits[item.id] || {};
                  return (
                    <div key={item.id} style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 10 }}>
                      <div className="between">
                        <span>
                          <strong>{item.accountName || item.accountId}</strong>{' '}
                          <span className={`badge platform-${item.platform}`}>{item.platform}</span>
                        </span>
                        <span className={`badge ${item.status}`}>{item.status} ({Math.round(item.progressPct || 0)}%)</span>
                      </div>

                      {['uploading', 'processing', 'staging', 'transcoding'].includes(item.status) && (
                        <div className="progress-bar">
                          <div className="progress-fill" style={{ width: `${Math.max(5, item.progressPct || 0)}%` }} />
                        </div>
                      )}

                      {item.publishedUrl && (
                        <p style={{ margin: '6px 0' }}>
                          Published URL:{' '}
                          <a href={item.publishedUrl} target="_blank" rel="noreferrer" style={{ color: '#38bdf8' }}>
                            {item.publishedUrl}
                          </a>
                        </p>
                      )}
                      {item.errorMessage && (
                        <p style={{ color: '#fca5a5', fontSize: '0.84rem', margin: '6px 0' }}>
                          [{item.errorCode}] {item.errorMessage}
                        </p>
                      )}

                      {job.status === 'awaiting_approval' ? (
                        <div style={{ marginTop: 8 }}>
                          {item.platform === 'youtube' ? (
                            <>
                              <label>YouTube Title</label>
                              <input
                                value={editState.title ?? item.metadata?.title ?? ''}
                                onChange={(e) =>
                                  setDraftEdits((p) => ({
                                    ...p,
                                    [item.id]: { ...p[item.id], title: e.target.value },
                                  }))
                                }
                              />
                              <label>YouTube Description</label>
                              <textarea
                                value={editState.description ?? item.metadata?.description ?? ''}
                                onChange={(e) =>
                                  setDraftEdits((p) => ({
                                    ...p,
                                    [item.id]: { ...p[item.id], description: e.target.value },
                                  }))
                                }
                              />
                              <label>YouTube Visibility</label>
                              <select
                                value={editState.privacyStatus ?? item.metadata?.privacyStatus ?? 'private'}
                                onChange={(e) =>
                                  setDraftEdits((p) => ({
                                    ...p,
                                    [item.id]: { ...p[item.id], privacyStatus: e.target.value },
                                  }))
                                }
                              >
                                <option value="private">Private</option>
                                <option value="unlisted">Unlisted</option>
                                <option value="public">Public</option>
                              </select>
                            </>
                          ) : (
                            <>
                              <label>Instagram Reels Caption</label>
                              <textarea
                                value={editState.caption ?? item.metadata?.caption ?? ''}
                                onChange={(e) =>
                                  setDraftEdits((p) => ({
                                    ...p,
                                    [item.id]: { ...p[item.id], caption: e.target.value },
                                  }))
                                }
                              />
                              <label>Instagram Visibility Mode</label>
                              <select
                                value={editState.instagramVisibility ?? item.metadata?.instagramVisibility ?? 'public'}
                                onChange={(e) =>
                                  setDraftEdits((p) => ({
                                    ...p,
                                    [item.id]: { ...p[item.id], instagramVisibility: e.target.value },
                                  }))
                                }
                              >
                                <option value="public">Public (Feed + Reels, or Private IG followers)</option>
                                <option value="reels_only">Reels Tab Only (hidden from main profile grid)</option>
                                <option value="trial_manual">Trial Reel (hidden from profile &amp; followers until promoted)</option>
                                <option value="private">Private IG Creator Account</option>
                              </select>
                              {(editState.instagramVisibility ?? item.metadata?.instagramVisibility) === 'private' && (
                                <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                                  <input
                                    type="checkbox"
                                    style={{ width: 'auto' }}
                                    checked={Boolean(
                                      editState.confirmPrivateInstagramAccount ??
                                        item.metadata?.confirmPrivateInstagramAccount
                                    )}
                                    onChange={(e) =>
                                      setDraftEdits((p) => ({
                                        ...p,
                                        [item.id]: {
                                          ...p[item.id],
                                          confirmPrivateInstagramAccount: e.target.checked,
                                        },
                                      }))
                                    }
                                  />
                                  I confirm this Instagram Creator account is set to Private in Instagram Settings
                                </label>
                              )}
                            </>
                          )}
                        </div>
                      ) : (
                        <p className="muted" style={{ margin: '6px 0' }}>
                          {item.platform === 'youtube'
                            ? `Title: ${item.metadata?.title || '—'} (${item.metadata?.privacyStatus || 'private'})`
                            : `Visibility: ${item.metadata?.instagramVisibility || 'public'} • Caption: ${(item.metadata?.caption || '').slice(0, 120)}`}
                        </p>
                      )}
                    </div>
                  );
                })}

                <div className="row" style={{ marginTop: 12 }}>
                  {job.status === 'awaiting_approval' && (
                    <>
                      <button className="btn primary" onClick={() => handleApproveJob(job)}>
                        Approve &amp; Publish
                      </button>
                      <button className="btn danger" onClick={() => handleCancelJob(job.id)}>
                        Cancel
                      </button>
                    </>
                  )}
                  {(job.status === 'failed' || job.status === 'partial_success') && (
                    <button className="btn primary" onClick={() => handleRetryJob(job.id)}>
                      Retry Failed Destination(s)
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'settings' && settings && (
        <form className="card" onSubmit={handleSaveSettings}>
          <div className="card-header">
            <h2>Publishing Settings</h2>
          </div>

          <label>Publishing Mode</label>
          <select
            value={settings.publishMode}
            onChange={(e) => setSettings({ ...settings, publishMode: e.target.value })}
          >
            <option value="review">Review Mode (Generate metadata &amp; wait for approval — Default)</option>
            <option value="autopilot">Autopilot Mode (Publish automatically to authorized accounts)</option>
          </select>

          <label>Default YouTube Privacy Status</label>
          <select
            value={settings.defaultPrivacyStatus}
            onChange={(e) => setSettings({ ...settings, defaultPrivacyStatus: e.target.value })}
          >
            <option value="private">Private</option>
            <option value="unlisted">Unlisted</option>
            <option value="public">Public</option>
          </select>

          <label>Default Authorized Accounts (used when Autopilot runs without explicit accounts)</label>
          <div style={{ marginTop: 6 }}>
            {accounts.map((acc) => {
              const checked = (settings.defaultAccountIds || []).includes(acc.id);
              return (
                <label key={acc.id} style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text)' }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={checked}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...(settings.defaultAccountIds || []), acc.id]
                        : (settings.defaultAccountIds || []).filter((id) => id !== acc.id);
                      setSettings({ ...settings, defaultAccountIds: next });
                    }}
                  />
                  {acc.displayName} ({acc.platform})
                </label>
              );
            })}
          </div>

          <label>Watched Video Output Directories (one per line)</label>
          <textarea value={watchDirsText} onChange={(e) => setWatchDirsText(e.target.value)} />

          <button className="btn primary" style={{ marginTop: 14 }} type="submit">
            Save Settings
          </button>
        </form>
      )}

      {tab === 'r2' && (
        <>
          <div className="card">
            <div className="card-header">
              <h2>Cloudflare R2 Free-Tier Cost Protection ({r2Usage?.counters?.monthKey || 'Current Month'})</h2>
              <div className="row">
                <button className="btn" disabled={r2Busy} onClick={() => handleRefreshR2Usage(true)}>
                  {r2Busy ? 'Checking...' : 'Check Live Bucket Usage'}
                </button>
                <button className="btn primary" disabled={r2Busy} onClick={handleRunR2Cleanup}>
                  Run 24h &amp; Multipart Cleanup
                </button>
              </div>
            </div>

            <div className="alert info">
              <strong>Important Notice:</strong> {r2Usage?.disclaimer || 'Application-level cost safeguards only — NOT a Cloudflare billing cap or account-level spend limit. Monitor your Cloudflare R2 Dashboard and billing notifications separately.'}
            </div>

            {r2Usage?.measurementError && (
              <div className="alert error">
                <strong>Fail-Closed Active:</strong> Cannot reliably measure R2 storage usage ({r2Usage.measurementError}). New R2 uploads are blocked until usage measurement succeeds.
              </div>
            )}

            <p className="muted" style={{ marginBottom: 14 }}>
              Enforced Hard Limits: <strong>8 GB</strong> max total stored data • <strong>500 MB</strong> max video size •{' '}
              <strong>1</strong> concurrent R2 upload ({r2Usage?.activeConcurrentUploads || 0} active) •{' '}
              <strong>10</strong> max queued jobs • <strong>24h</strong> abandoned &amp; incomplete multipart cleanup •{' '}
              <strong>R2 Standard</strong> storage only • Private bucket + short-lived presigned URLs (&le; 1 hour).
            </p>

            {r2Usage ? (
              <div className="grid-2">
                {[
                  ['storageBytes', 'Stored Data (8 GB App Safety Cap vs 10 GB Free Tier)'],
                  ['monthlyUploads', 'Estimated Monthly R2 Uploads (Configurable Limit)'],
                  ['monthlyUploadBytes', 'Estimated Monthly Upload Volume (Configurable Limit)'],
                  ['monthlyClassAOps', 'Estimated Class A Ops (PUT/LIST/Multipart vs 1M/mo Free)'],
                  ['monthlyClassBOps', 'Estimated Class B Ops (Presigned GET vs 10M/mo Free)'],
                  ['queuedJobs', 'Active / Queued Publishing Jobs (Max 10)'],
                ].map(([key, title]) => {
                  const m = r2Usage.evaluation?.metrics?.[key];
                  const pct = m?.pct ?? 0;
                  return (
                    <div className="meter-card" key={key}>
                      <div className="between">
                        <strong>{title}</strong>
                        <span className={`badge ${m?.blocked ? 'failed' : m?.warningThreshold >= 70 ? 'uploading' : 'connected'}`}>
                          {m?.pct === null ? 'Unmeasured' : `${m.pct.toFixed(1)}%`}
                        </span>
                      </div>
                      <p className="muted" style={{ margin: '6px 0 4px' }}>{formatMetricValue(m)}</p>
                      <div className="progress-bar">
                        <div className={progressFillClass(m?.warningThreshold)} style={{ width: `${Math.min(100, pct)}%` }} />
                      </div>
                      {m?.warningThreshold && (
                        <p style={{ color: m.warningThreshold >= 95 ? '#f87171' : '#fbbf24', fontSize: '0.78rem', margin: '6px 0 0' }}>
                          Warning threshold crossed: {m.warningThreshold}% (alerts at 70%, 85%, 95%)
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="muted">Loading R2 usage telemetry...</p>
            )}

            {r2Usage?.counters && (
              <p className="muted" style={{ marginTop: 14 }}>
                This month: <strong>{r2Usage.counters.deleteCount}</strong> automatic object deletion(s) (free) •{' '}
                <strong>{r2Usage.counters.abortMultipartCount}</strong> aborted multipart upload(s) (free) •{' '}
                Last live measurement:{' '}
                {r2Usage.counters.lastMeasuredAt ? new Date(r2Usage.counters.lastMeasuredAt).toLocaleString() : 'Never measured yet'}
              </p>
            )}
          </div>

          <div className="card">
            <div className="card-header">
              <h3>Local R2 Storage &amp; Operation Audit Log</h3>
              <button className="btn" onClick={() => setTab('setup')}>Configure Monthly Upload Limits</button>
            </div>
            {(!r2Usage?.recentLogs || r2Usage.recentLogs.length === 0) ? (
              <p className="muted">No local R2 operations logged yet this month.</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="log-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Event / Operation</th>
                      <th>Class</th>
                      <th>Status</th>
                      <th>Object / Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r2Usage.recentLogs.map((log) => (
                      <tr key={log.id}>
                        <td>{new Date(log.createdAt).toLocaleString()}</td>
                        <td><code>{log.operation}</code> ({log.eventType})</td>
                        <td>{log.opClass}</td>
                        <td>
                          <span className={`badge ${log.status === 'ok' ? 'connected' : log.status === 'warning' ? 'uploading' : 'failed'}`}>
                            {log.warningLevel ? `${log.status} (${log.warningLevel}%)` : log.status}
                          </span>
                        </td>
                        <td className="muted">
                          {log.objectKey ? <code>{log.objectKey}</code> : ''}
                          {log.bytesDelta ? ` • ${formatBytes(Math.abs(log.bytesDelta))}` : ''}
                          {log.details?.error ? ` • ${log.details.error}` : ''}
                          {log.details?.message ? ` • ${log.details.message}` : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {tab === 'setup' && (
        <form className="card" onSubmit={handleSaveCredentials}>
          <div className="card-header">
            <h2>Secure Local Credential Configuration</h2>
          </div>
          <p className="muted">
            Secrets entered here are encrypted with AES-256-GCM (master key in Windows Credential Manager) and never
            sent back to the browser or AI chat. Leave fields blank to keep existing values.
          </p>

          <div className="grid-2">
            <div>
              <h3>YouTube Data API v3 {setupStatus?.youtube?.configured ? '✅' : '⚠️'}</h3>
              <p className="muted">Client ID: {setupStatus?.youtube?.clientIdMasked || 'Not set'}</p>
              <p className="muted">
                Google Cloud OAuth Type: <strong>Web application</strong>. Add exact Authorized Redirect URI:{' '}
                <code>{setupStatus?.youtube?.redirectUri || 'http://127.0.0.1:4815/api/accounts/oauth/callback/youtube'}</code>{' '}
                <button
                  type="button"
                  className="btn"
                  style={{ padding: '2px 8px', fontSize: '0.75rem' }}
                  onClick={() => {
                    const uri = setupStatus?.youtube?.redirectUri || 'http://127.0.0.1:4815/api/accounts/oauth/callback/youtube';
                    navigator.clipboard?.writeText(uri)
                      .then(() => notify('success', 'Copied YouTube Authorized Redirect URI.'))
                      .catch(() => notify('error', `Copy manually: ${uri}`));
                  }}
                >
                  Copy
                </button>
              </p>
              <label>Google OAuth Client ID</label>
              <input value={credForm.ytClientId} onChange={(e) => setCredForm({ ...credForm, ytClientId: e.target.value })} />
              <label>Google OAuth Client Secret</label>
              <input type="password" value={credForm.ytClientSecret} onChange={(e) => setCredForm({ ...credForm, ytClientSecret: e.target.value })} />
            </div>

            <div>
              <h3>Instagram Graph API {setupStatus?.instagram?.configured ? '✅' : '⚠️'}</h3>
              {(() => {
                const activeSetupIgMode = credForm.igLoginMode || setupStatus?.instagram?.loginMode || 'meta_unified_login';
                return (
                  <>
                    <p className="muted">
                      App ID: {setupStatus?.instagram?.appIdMasked || 'Not set'} • App Secret:{' '}
                      {setupStatus?.instagram?.hasAppSecret ? 'Saved' : 'Not set'}
                    </p>
                    <p className="muted">
                      Config ID: <code>{setupStatus?.instagram?.configId || 'Not set'}</code>{' '}
                      {setupStatus?.instagram?.configId && (
                        <button
                          type="button"
                          className="btn"
                          style={{ padding: '2px 8px', fontSize: '0.75rem' }}
                          onClick={handleClearIgConfigId}
                        >
                          Clear
                        </button>
                      )}
                    </p>
                    <p className="muted">
                      Meta Valid OAuth Redirect URI:{' '}
                      <code>{setupStatus?.instagram?.redirectUri || 'http://127.0.0.1:4815/api/accounts/oauth/callback/instagram'}</code>{' '}
                      <button
                        type="button"
                        className="btn"
                        style={{ padding: '2px 8px', fontSize: '0.75rem' }}
                        onClick={() => {
                          const uri =
                            credForm.igRedirectUri.trim() ||
                            setupStatus?.instagram?.redirectUri ||
                            'http://127.0.0.1:4815/api/accounts/oauth/callback/instagram';
                          navigator.clipboard?.writeText(uri)
                            .then(() => notify('success', 'Copied Instagram Valid OAuth Redirect URI.'))
                            .catch(() => notify('error', `Copy manually: ${uri}`));
                        }}
                      >
                        Copy
                      </button>{' '}
                      {String(setupStatus?.instagram?.redirectUri || '').startsWith('https://') && (
                        <button
                          type="button"
                          className="btn"
                          style={{ padding: '2px 8px', fontSize: '0.75rem' }}
                          onClick={handleResetIgRedirectUri}
                        >
                          Reset to Loopback
                        </button>
                      )}
                    </p>
                    <label>Default Instagram OAuth Mode</label>
                    <select
                      value={activeSetupIgMode}
                      onChange={(e) => setCredForm({ ...credForm, igLoginMode: e.target.value })}
                    >
                      <option value="meta_unified_login">Meta Unified Login (Recommended — Business Config ID + HTTPS)</option>
                      <option value="facebook_login">Facebook Login for Business (Legacy Page-linked IG)</option>
                      <option value="instagram_login">Instagram Login (Legacy Standalone IG OAuth — requires HTTPS)</option>
                    </select>
                    {activeSetupIgMode === 'meta_unified_login' && (
                      <p className="muted" style={{ marginTop: 8, fontSize: '0.8rem' }}>
                        Get <strong>App ID &amp; App Secret</strong> from Meta Developer Portal → <strong>App settings → Basic</strong>, and
                        <strong> Configuration ID</strong> from <strong>Instagram → API setup with Unified login</strong>. Never paste generated{' '}
                        <code>EAA...</code> / <code>IGAA...</code> access tokens into App ID or App Secret.
                      </p>
                    )}
                    <label>
                      {activeSetupIgMode === 'instagram_login'
                        ? 'Instagram App ID (Instagram API with Instagram Login)'
                        : 'Meta App ID (from App settings -> Basic)'}
                    </label>
                    <input
                      value={credForm.igAppId}
                      onChange={(e) => setCredForm({ ...credForm, igAppId: e.target.value })}
                      placeholder={
                        activeSetupIgMode === 'instagram_login'
                          ? 'Instagram App ID'
                          : 'Numeric Meta App ID (not an access token)'
                      }
                    />
                    <label>
                      {activeSetupIgMode === 'instagram_login'
                        ? 'Instagram App Secret'
                        : 'Meta App Secret (from App settings -> Basic)'}
                    </label>
                    <input
                      type="password"
                      value={credForm.igAppSecret}
                      onChange={(e) => setCredForm({ ...credForm, igAppSecret: e.target.value })}
                      placeholder={
                        activeSetupIgMode === 'instagram_login'
                          ? 'Instagram App Secret'
                          : 'Meta App Secret (not a generated access token)'
                      }
                    />
                    {(activeSetupIgMode === 'meta_unified_login' || setupStatus?.instagram?.configId) && (
                      <>
                        <label>Meta Unified Login Configuration ID (<code>config_id</code>)</label>
                        <input
                          value={credForm.igConfigId}
                          onChange={(e) => setCredForm({ ...credForm, igConfigId: e.target.value })}
                          placeholder={setupStatus?.instagram?.configId || 'e.g. 1608840587925023'}
                        />
                      </>
                    )}
                    <label>
                      Instagram HTTPS Redirect URI (run <code>npm run tunnel</code> for Unified / Instagram Login)
                    </label>
                    <input
                      value={credForm.igRedirectUri}
                      onChange={(e) => setCredForm({ ...credForm, igRedirectUri: e.target.value })}
                      placeholder={setupStatus?.instagram?.redirectUri || 'https://<tunnel>.trycloudflare.com/api/accounts/oauth/callback/instagram'}
                    />
                  </>
                );
              })()}
            </div>

            <div>
              <h3>Cloudflare R2 / S3 Temp Staging {setupStatus?.storage?.configured ? '✅' : '⚠️'}</h3>
              <p className="muted">
                Bucket: {setupStatus?.storage?.bucket || 'Not set'} • Storage: R2 Standard Only • Private Access Only
              </p>
              <label>Cloudflare Account ID</label>
              <input value={credForm.r2AccountId} onChange={(e) => setCredForm({ ...credForm, r2AccountId: e.target.value })} />
              <label>Private R2/S3 Bucket Name (must already exist — never auto-created)</label>
              <input value={credForm.r2Bucket} onChange={(e) => setCredForm({ ...credForm, r2Bucket: e.target.value })} />
              <label>Access Key ID</label>
              <input value={credForm.r2AccessKeyId} onChange={(e) => setCredForm({ ...credForm, r2AccessKeyId: e.target.value })} />
              <label>Secret Access Key</label>
              <input type="password" value={credForm.r2SecretAccessKey} onChange={(e) => setCredForm({ ...credForm, r2SecretAccessKey: e.target.value })} />
              <label>Custom S3 Endpoint URL (optional, auto-built from Cloudflare Account ID)</label>
              <input value={credForm.r2Endpoint} onChange={(e) => setCredForm({ ...credForm, r2Endpoint: e.target.value })} placeholder={setupStatus?.storage?.endpoint || 'https://<accountId>.r2.cloudflarestorage.com'} />
              <div className="grid-2">
                <div>
                  <label>Monthly Upload Count Limit (current: {setupStatus?.storage?.monthlyUploadLimitCount ?? 200})</label>
                  <input
                    type="number"
                    min="1"
                    max="10000"
                    value={credForm.r2MonthlyUploadLimitCount}
                    onChange={(e) => setCredForm({ ...credForm, r2MonthlyUploadLimitCount: e.target.value })}
                    placeholder={String(setupStatus?.storage?.monthlyUploadLimitCount ?? 200)}
                  />
                </div>
                <div>
                  <label>Monthly Upload Volume Limit MB (current: {setupStatus?.storage?.monthlyUploadLimitMb ?? 10240} MB)</label>
                  <input
                    type="number"
                    min="1"
                    max="102400"
                    value={credForm.r2MonthlyUploadLimitMb}
                    onChange={(e) => setCredForm({ ...credForm, r2MonthlyUploadLimitMb: e.target.value })}
                    placeholder={String(setupStatus?.storage?.monthlyUploadLimitMb ?? 10240)}
                  />
                </div>
              </div>
              <div className="grid-2">
                <div>
                  <label>Short-Lived Presigned URL TTL sec (60–3600, current: {setupStatus?.storage?.urlTtlSeconds ?? 1800})</label>
                  <input
                    type="number"
                    min="60"
                    max="3600"
                    value={credForm.r2UrlTtlSeconds}
                    onChange={(e) => setCredForm({ ...credForm, r2UrlTtlSeconds: e.target.value })}
                    placeholder={String(setupStatus?.storage?.urlTtlSeconds ?? 1800)}
                  />
                </div>
                <div>
                  <label>Temp Retention Minutes (5–1440, current: {setupStatus?.storage?.retentionMinutes ?? 60})</label>
                  <input
                    type="number"
                    min="5"
                    max="1440"
                    value={credForm.r2RetentionMinutes}
                    onChange={(e) => setCredForm({ ...credForm, r2RetentionMinutes: e.target.value })}
                    placeholder={String(setupStatus?.storage?.retentionMinutes ?? 60)}
                  />
                </div>
              </div>
            </div>

            <div>
              <h3>AI Metadata Providers &amp; Console Lock</h3>
              <label>Preferred AI Provider</label>
              <select
                value={credForm.aiProvider || setupStatus?.ai?.provider || 'auto'}
                onChange={(e) => setCredForm({ ...credForm, aiProvider: e.target.value })}
              >
                <option value="auto">Auto (Gemini → OpenAI → Anthropic → Ollama → Grounded)</option>
                <option value="gemini">Gemini</option>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="ollama">Local Ollama</option>
                <option value="deterministic">Deterministic (Transcript/Script only)</option>
              </select>
              <label>Gemini API Key ({setupStatus?.ai?.geminiKeyMasked || 'Not set'})</label>
              <input type="password" value={credForm.geminiApiKey} onChange={(e) => setCredForm({ ...credForm, geminiApiKey: e.target.value })} />
              <label>OpenAI API Key ({setupStatus?.ai?.openaiKeyMasked || 'Not set'})</label>
              <input type="password" value={credForm.openaiApiKey} onChange={(e) => setCredForm({ ...credForm, openaiApiKey: e.target.value })} />
              <label>Anthropic API Key ({setupStatus?.ai?.anthropicKeyMasked || 'Not set'})</label>
              <input type="password" value={credForm.anthropicApiKey} onChange={(e) => setCredForm({ ...credForm, anthropicApiKey: e.target.value })} />
              <label>Ollama Base URL / Model</label>
              <div className="grid-2">
                <input value={credForm.ollamaBaseUrl} onChange={(e) => setCredForm({ ...credForm, ollamaBaseUrl: e.target.value })} placeholder={setupStatus?.ai?.ollamaBaseUrl || 'http://127.0.0.1:11434'} />
                <input value={credForm.ollamaModel} onChange={(e) => setCredForm({ ...credForm, ollamaModel: e.target.value })} placeholder={setupStatus?.ai?.ollamaModel || 'qwen3:8b'} />
              </div>
              <label>Dashboard Unlock Passcode (min 8 chars, optional)</label>
              <input type="password" value={credForm.dashboardPasscode} onChange={(e) => setCredForm({ ...credForm, dashboardPasscode: e.target.value })} />
            </div>
          </div>

          <button className="btn primary" style={{ marginTop: 16 }} type="submit">
            Encrypt &amp; Save Credentials Locally
          </button>
        </form>
      )}
    </div>
  );
}

