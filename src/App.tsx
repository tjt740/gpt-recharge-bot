import {
  AlertCircle,
  ArrowLeft,
  BadgeCheck,
  CheckCircle2,
  ClipboardCheck,
  Database,
  ExternalLink,
  KeyRound,
  Loader2,
  LockKeyhole,
  LogIn,
  Mail,
  PackageCheck,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  UserCircle2,
  X,
} from 'lucide-react';
import { FormEvent, useEffect, useMemo, useState } from 'react';

const DEFAULT_API_BASE = '/api';
const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? DEFAULT_API_BASE).replace(/\/$/, '');
const INVENTORY_KEYS = new Set(['lhm', 'tjt']);
const CHATGPT_SESSION_URL = 'https://chatgpt.com/api/auth/session';
const OPENAI_LOGIN_URL = 'https://auth.openai.com/log-in-or-create-account';
const TOKEN_PLACEHOLDER =
  '{"account":{"id":"5ad0a5c2-e5e7-48d1-b694-a7776081e519"},"accessToken":"...","sessionToken":"...","user":{"email":"user@example.com"}}';
const HISTORY_STORAGE_KEY = 'card-recharge-records';

type ApiEnvelope<T> = {
  code: number;
  msg: string;
  data: T;
};

type CardStatus = 0 | 1 | number;

type CardRecord = {
  id: number;
  batch_id: number;
  code_plain: string;
  status: CardStatus;
  redeemed_at: string | null;
  client_id: string | null;
  client_email: string | null;
  created_at: string;
};

type Inventory = {
  count: number;
  status: string;
  label: string;
};

type RedeemResult = {
  result: string;
};

type Notice = {
  type: 'success' | 'error' | 'info';
  message: string;
};

type Step = 'card' | 'account' | 'done';
type RouteName = 'home' | 'records';

type TokenPayload = {
  user?: {
    email?: unknown;
  };
  account?: {
    id?: unknown;
  };
  expires?: unknown;
  accessToken?: unknown;
  sessionToken?: unknown;
  [key: string]: unknown;
};

const statusMeta = {
  0: { label: '未兑换', className: 'available' },
  1: { label: '已兑换', className: 'used' },
} as const;

function isRecordAvailable(record: CardRecord | null) {
  return record?.status === 0;
}

function formatDateTime(value: string | null) {
  if (!value) return '未记录';

  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function maskValue(value: string) {
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}

function normalizeTokenPayload(value: string) {
  return value.trim();
}

function parseTokenPayload(value: string): TokenPayload | null {
  const token = normalizeTokenPayload(value);
  if (!token) return null;

  try {
    const parsed = JSON.parse(token) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as TokenPayload;
  } catch {
    return null;
  }
}

function maskSecret(value: unknown) {
  if (typeof value !== 'string' || !value) return '未识别';
  if (value.length <= 16) return '已填写';
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function maskTokenPayload(value: string) {
  const token = normalizeTokenPayload(value);
  if (!token) return '-';

  const payload = parseTokenPayload(token);
  if (!payload) return 'Token JSON 已填写，格式待校验';

  const email = typeof payload.user?.email === 'string' ? payload.user.email : '未识别邮箱';
  const accountId = getTokenAccountId(token);
  return `Token JSON / 账户 ${accountId ? maskValue(accountId) : '未识别'} / ${email} / access ${maskSecret(payload.accessToken)} / session ${maskSecret(payload.sessionToken)}`;
}

function getTokenEmail(value: string) {
  const payload = parseTokenPayload(value);
  return typeof payload?.user?.email === 'string' ? payload.user.email : '';
}

function getTokenAccountId(value: string) {
  const payload = parseTokenPayload(value);
  return typeof payload?.account?.id === 'string' ? payload.account.id.trim() : '';
}

function getRechargeEmail(tokenValue: string, inputValue: string) {
  return inputValue.trim() || getTokenEmail(tokenValue);
}

function validateTokenPayload(value: string) {
  const token = normalizeTokenPayload(value);
  if (!token) return '请输入 Token JSON';

  const payload = parseTokenPayload(token);
  if (!payload) return 'Token 必须是完整的 JSON 对象';
  if (typeof payload.accessToken !== 'string' || !payload.accessToken.trim()) {
    return 'Token JSON 缺少 accessToken';
  }
  if (typeof payload.sessionToken !== 'string' || !payload.sessionToken.trim()) {
    return 'Token JSON 缺少 sessionToken';
  }
  if (!getTokenAccountId(token)) {
    return 'Token JSON 缺少 account.id';
  }

  if (typeof payload.expires === 'string') {
    const expiresAt = new Date(payload.expires).getTime();
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      return 'Token 已过期，请更换新的 Token JSON';
    }
  }

  return null;
}

function normalizeCode(value: string) {
  return value.trim().replace(/\s+/g, '').toUpperCase();
}

function getStatusLabel(status: CardStatus) {
  return statusMeta[status as 0 | 1]?.label ?? `状态 ${status}`;
}

function getStatusClass(status: CardStatus) {
  return statusMeta[status as 0 | 1]?.className ?? 'unknown';
}

function getInventoryClass(inventory: Inventory | null) {
  const status = `${inventory?.status ?? ''}`.toLowerCase();
  const label = inventory?.label ?? '';

  if (!inventory) return 'loading';
  if (status.includes('empty') || status.includes('none') || status.includes('out') || label.includes('没有')) {
    return 'empty';
  }
  if (status.includes('low') || label.includes('少量')) {
    return 'low';
  }
  if (status.includes('sufficient') || status.includes('normal') || label.includes('充足')) {
    return 'sufficient';
  }

  return status || 'unknown';
}

function getCurrentRoute(): RouteName {
  const hashRoute = window.location.hash.replace(/^#/, '').replace(/\/$/, '');
  if (hashRoute === '/records' || hashRoute === 'records') return 'records';
  return window.location.pathname.endsWith('/records') ? 'records' : 'home';
}

function getBasePath() {
  const pathname = window.location.pathname || '/';
  return pathname.endsWith('/records') ? pathname.slice(0, -'/records'.length) || '/' : pathname;
}

function getRouteUrl(routeName: RouteName) {
  const hash = routeName === 'records' ? '#/records' : '#/';
  return `${getBasePath()}${hash}`;
}

function sanitizeHistoryRecord(record: CardRecord): CardRecord {
  return {
    ...record,
    client_id: null,
  };
}

function readStoredHistory(): CardRecord[] {
  try {
    const stored = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored) as unknown;
    return Array.isArray(parsed) ? (parsed as CardRecord[]).slice(0, 30) : [];
  } catch {
    return [];
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
    ...init,
  });

  let payload: ApiEnvelope<T> | null = null;
  try {
    payload = (await response.json()) as ApiEnvelope<T>;
  } catch {
    throw new Error(`接口返回异常，HTTP ${response.status}`);
  }

  if (!response.ok || payload.code !== 0) {
    throw new Error(payload.msg || `请求失败，HTTP ${response.status}`);
  }

  return payload.data;
}

function App() {
  const [route, setRoute] = useState<RouteName>(() => getCurrentRoute());
  const [step, setStep] = useState<Step>('card');
  const [cardCode, setCardCode] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientEmail, setClientEmail] = useState('');
  const [checkedCard, setCheckedCard] = useState<CardRecord | null>(null);
  const [history, setHistory] = useState<CardRecord[]>(() => readStoredHistory());
  const [notice, setNotice] = useState<Notice | null>(null);
  const [redeemMessage, setRedeemMessage] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [showInventoryModal, setShowInventoryModal] = useState(false);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [inventorySecret, setInventorySecret] = useState('');
  const [inventoryAccessGranted, setInventoryAccessGranted] = useState(false);
  const [inventoryError, setInventoryError] = useState('');
  const [queryLoading, setQueryLoading] = useState(false);
  const [redeemLoading, setRedeemLoading] = useState(false);

  const normalizedCode = useMemo(() => normalizeCode(cardCode), [cardCode]);
  const normalizedToken = useMemo(() => normalizeTokenPayload(clientId), [clientId]);
  const canProceedToAccount = isRecordAvailable(checkedCard);

  function handleTokenChange(value: string) {
    setClientId(value);

    if (!clientEmail.trim()) {
      const tokenEmail = getTokenEmail(value);
      if (tokenEmail) setClientEmail(tokenEmail);
    }
  }

  async function loadInventory() {
    setInventoryLoading(true);
    try {
      const data = await requestJson<Inventory>('/cards/inventory', {
        method: 'GET',
      });
      setInventory(data);
    } catch (error) {
      setNotice({
        type: 'error',
        message: error instanceof Error ? error.message : '库存查询失败',
      });
    } finally {
      setInventoryLoading(false);
    }
  }

  useEffect(() => {
    void loadInventory();
  }, []);

  useEffect(() => {
    const handleRouteChange = () => setRoute(getCurrentRoute());
    window.addEventListener('hashchange', handleRouteChange);
    window.addEventListener('popstate', handleRouteChange);
    return () => {
      window.removeEventListener('hashchange', handleRouteChange);
      window.removeEventListener('popstate', handleRouteChange);
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history.map(sanitizeHistoryRecord)));
  }, [history]);

  function navigate(routeName: RouteName) {
    window.history.pushState(null, '', getRouteUrl(routeName));
    setRoute(routeName);
  }

  function updateHistory(record: CardRecord) {
    const safeRecord = sanitizeHistoryRecord(record);
    setHistory((records) => [safeRecord, ...records.filter((item) => item.id !== safeRecord.id)].slice(0, 30));
  }

  function handleInventoryAccess() {
    if (INVENTORY_KEYS.has(inventorySecret.trim().toLowerCase())) {
      setInventoryAccessGranted(true);
      setInventoryError('');
      return;
    }

    setInventoryAccessGranted(false);
    setInventoryError('授权码不正确');
  }

  async function handleQueryCard(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!normalizedCode) {
      setNotice({ type: 'error', message: '请输入卡密后再查询' });
      return;
    }

    setQueryLoading(true);
    setNotice(null);
    setRedeemMessage('');

    try {
      const data = await requestJson<CardRecord>('/cards/query', {
        method: 'POST',
        body: JSON.stringify({ code: normalizedCode }),
      });

      setCheckedCard(data);
      updateHistory(data);

      if (data.status === 0) {
        setStep('account');
        setNotice({ type: 'success', message: '卡密可用，请继续输入充值账户信息' });
      } else {
        setStep('card');
        setNotice({ type: 'error', message: '该卡密已兑换，不能继续充值' });
      }
    } catch (error) {
      setCheckedCard(null);
      setStep('card');
      setNotice({
        type: 'error',
        message: error instanceof Error ? error.message : '卡密查询失败',
      });
    } finally {
      setQueryLoading(false);
    }
  }

  function handleOpenConfirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!isRecordAvailable(checkedCard)) {
      setNotice({ type: 'error', message: '请先完成可用卡密查询' });
      setStep('card');
      return;
    }

    const tokenError = validateTokenPayload(normalizedToken);
    if (tokenError) {
      setNotice({ type: 'error', message: tokenError });
      return;
    }

    const rechargeEmail = getRechargeEmail(normalizedToken, clientEmail);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rechargeEmail)) {
      setNotice({ type: 'error', message: '请输入有效的充值账户邮箱' });
      return;
    }

    setNotice(null);
    setShowConfirm(true);
  }

  async function handleRedeem() {
    if (!checkedCard) return;

    setRedeemLoading(true);
    setNotice(null);
    const rechargeEmail = getRechargeEmail(normalizedToken, clientEmail);
    const clientAccountId = getTokenAccountId(normalizedToken);

    if (!clientAccountId) {
      setRedeemLoading(false);
      setNotice({ type: 'error', message: 'Token JSON 缺少 account.id，无法识别充值账户 ID' });
      return;
    }

    try {
      const data = await requestJson<RedeemResult>('/cards/redeem', {
        method: 'POST',
        body: JSON.stringify({
          code: checkedCard.code_plain,
          client_id: clientAccountId,
          client_email: rechargeEmail,
        }),
      });

      const redeemedAt = new Date().toISOString();

      setRedeemMessage(data.result);
      setStep('done');
      setShowConfirm(false);
      setClientId('');
      setCheckedCard({
        ...checkedCard,
        status: 1,
        redeemed_at: redeemedAt,
        client_id: null,
        client_email: rechargeEmail,
      });
      setHistory((records) =>
        records.map((item) =>
          item.id === checkedCard.id
            ? {
                ...item,
                status: 1,
                redeemed_at: redeemedAt,
                client_id: null,
                client_email: rechargeEmail,
              }
            : item,
        ),
      );
      setNotice({ type: 'success', message: '兑换请求已完成' });
      void loadInventory();
    } catch (error) {
      setNotice({
        type: 'error',
        message: error instanceof Error ? error.message : '兑换失败',
      });
    } finally {
      setRedeemLoading(false);
    }
  }

  function resetFlow() {
    setStep('card');
    setCardCode('');
    setClientId('');
    setClientEmail('');
    setCheckedCard(null);
    setRedeemMessage('');
    setNotice(null);
  }

  function openExternal(url: string) {
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  function restoreRecord(record: CardRecord) {
    setCheckedCard(record);
    setCardCode(record.code_plain);
    setStep(record.status === 0 ? 'account' : 'card');
    navigate('home');
  }

  if (route === 'records') {
    return (
      <>
        <main className="shell">
          <section className="topbar records-topbar" aria-label="记录页标题">
            <div>
              <p className="page-kicker">Records</p>
              <h1>卡密充值记录</h1>
              <p className="page-subtitle">仅保存当前浏览器最近查询和兑换记录，不保存完整 Token。</p>
            </div>
            <button className="secondary-button nav-button" type="button" onClick={() => navigate('home')}>
              <ArrowLeft size={18} aria-hidden="true" />
              返回充值
            </button>
          </section>

          <section className="records-page">
            <div className="records-toolbar">
              <div>
                <h2>查询记录</h2>
                <p>{history.length > 0 ? `共 ${history.length} 条本地记录` : '暂无本地记录'}</p>
              </div>
              {history.length > 0 ? (
                <button className="secondary-button" type="button" onClick={() => setHistory([])}>
                  清空记录
                </button>
              ) : null}
            </div>

            {history.length === 0 ? (
              <div className="empty-state records-empty">
                <ClipboardCheck size={34} aria-hidden="true" />
                <p>完成卡密查询后，这里会显示记录。</p>
              </div>
            ) : (
              <div className="records-grid">
                {history.map((record) => (
                  <button className="record-card" key={record.id} type="button" onClick={() => restoreRecord(record)}>
                    <span className={`status-pill ${getStatusClass(record.status)}`}>
                      {getStatusLabel(record.status)}
                    </span>
                    <strong>{maskValue(record.code_plain)}</strong>
                    <dl>
                      <div>
                        <dt>账户邮箱</dt>
                        <dd>{record.client_email ?? '未绑定账户'}</dd>
                      </div>
                      <div>
                        <dt>创建时间</dt>
                        <dd>{formatDateTime(record.created_at)}</dd>
                      </div>
                      <div>
                        <dt>兑换时间</dt>
                        <dd>{formatDateTime(record.redeemed_at)}</dd>
                      </div>
                    </dl>
                  </button>
                ))}
              </div>
            )}
          </section>
        </main>
      </>
    );
  }

  return (
    <>
    <main className="shell">
      <section className="topbar" aria-label="页面标题和库存">
        <div>
          <p className="page-kicker">Recharge</p>
          <h1>ChatGPT 自助充值中心</h1>
          <p className="page-subtitle">清爽、安全的卡密兑换流程。</p>
        </div>

        <div className="top-actions">
          <button className="record-top-button" type="button" onClick={() => navigate('records')}>
            <ClipboardCheck size={18} aria-hidden="true" />
            <span>充值记录</span>
            <strong>{history.length}</strong>
          </button>
          <button
            className={`inventory-tag ${getInventoryClass(inventory)}`}
            type="button"
            onClick={() => setShowInventoryModal(true)}
            title="点击查看库存详情"
          >
            <Database size={18} aria-hidden="true" />
            <span>{inventoryLoading ? '库存读取中' : inventory?.label ?? '库存未知'}</span>
          </button>
          <button className="icon-button" type="button" onClick={loadInventory} title="刷新库存">
            <RefreshCw size={18} className={inventoryLoading ? 'spin' : ''} aria-hidden="true" />
          </button>
        </div>
      </section>

      <section className="layout home-layout">
        <div className="workspace">
          <div className="steps" aria-label="兑换步骤">
            <div className={`step ${step === 'card' ? 'active' : ''} ${checkedCard ? 'done' : ''}`}>
              <span>1</span>
              <p>查询卡密</p>
            </div>
            {canProceedToAccount || step === 'done' ? (
              <>
                <div className={`step ${step === 'account' ? 'active' : ''} ${step === 'done' ? 'done' : ''}`}>
                  <span>2</span>
                  <p>确认账户</p>
                </div>
                <div className={`step ${step === 'done' ? 'active done' : ''}`}>
                  <span>3</span>
                  <p>完成兑换</p>
                </div>
              </>
            ) : null}
          </div>

          {notice ? (
            <div className={`notice ${notice.type}`} role="status">
              {notice.type === 'success' ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
              <span>{notice.message}</span>
            </div>
          ) : null}

          {step === 'card' ? (
            <section className="panel">
              <div className="panel-heading">
                <KeyRound size={22} aria-hidden="true" />
                <div>
                  <h2>步骤 1：查询卡密状态</h2>
                  <p>只有状态为未兑换的卡密才能进入充值步骤。</p>
                </div>
              </div>

              <form className="form-grid" onSubmit={handleQueryCard}>
                <label className="field wide">
                  <span>激活码</span>
                  <input
                    value={cardCode}
                    onChange={(event) => setCardCode(event.target.value)}
                    placeholder="例如 CX029KIALGM3B7V3VFJTMYQ4YXQ9J644"
                    autoComplete="off"
                  />
                </label>
                <button className="primary-button" type="submit" disabled={queryLoading}>
                  {queryLoading ? <Loader2 size={18} className="spin" /> : <Search size={18} />}
                  <span>{queryLoading ? '查询中' : '查询卡密'}</span>
                </button>
              </form>

              {checkedCard ? (
                <div className="status-strip">
                  <div>
                    <span className={`status-dot ${getStatusClass(checkedCard.status)}`} />
                    <strong>{getStatusLabel(checkedCard.status)}</strong>
                  </div>
                  <dl>
                    <div>
                      <dt>卡密</dt>
                      <dd>{maskValue(checkedCard.code_plain)}</dd>
                    </div>
                    <div>
                      <dt>创建时间</dt>
                      <dd>{formatDateTime(checkedCard.created_at)}</dd>
                    </div>
                  <div>
                    <dt>兑换时间</dt>
                    <dd>{formatDateTime(checkedCard.redeemed_at)}</dd>
                  </div>
                  <div>
                    <dt>充值账户邮箱</dt>
                    <dd>{checkedCard.client_email ?? '未绑定账户'}</dd>
                  </div>
                </dl>
              </div>
            ) : null}
            </section>
          ) : null}

          {canProceedToAccount && step === 'account' ? (
            <section className="panel">
              <div className="panel-heading">
                <ShieldCheck size={22} aria-hidden="true" />
                <div>
                  <h2>步骤 2：输入 Token JSON 并确认账户</h2>
                  <p>提交前会弹出确认窗口，避免 Token 或账户填错。</p>
                </div>
              </div>

              <form className="account-form" onSubmit={handleOpenConfirm}>
                <div className="field full">
                  <div className="field-title-row">
                    <span>Token JSON</span>
                    <button
                      className="mini-button"
                      type="button"
                      onClick={(event) => {
                        event.preventDefault();
                        setShowAccountModal(true);
                      }}
                    >
                      <UserCircle2 size={16} aria-hidden="true" />
                      获取账号信息
                    </button>
                  </div>
                  <textarea
                    aria-label="Token JSON"
                    value={clientId}
                    onChange={(event) => handleTokenChange(event.target.value)}
                    placeholder={TOKEN_PLACEHOLDER}
                    autoComplete="off"
                  />
                  <small className="field-hint">粘贴完整 JSON，至少需要包含 account.id、accessToken 和 sessionToken。</small>
                </div>
                <label className="field">
                  <span>充值账户邮箱</span>
                  <input
                    value={clientEmail}
                    onChange={(event) => setClientEmail(event.target.value)}
                    placeholder="nova84@starwork.asia"
                    autoComplete="email"
                  />
                </label>
                <div className="button-row">
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => setStep('card')}
                    disabled={!checkedCard || redeemLoading}
                  >
                    返回查询
                  </button>
                  <button className="primary-button" type="submit">
                    <BadgeCheck size={18} />
                    <span>确认账户</span>
                  </button>
                </div>
              </form>
            </section>
          ) : null}

          {redeemMessage ? (
            <section className="panel result-panel">
              <div className="panel-heading">
                <ClipboardCheck size={22} aria-hidden="true" />
                <div>
                  <h2>兑换结果</h2>
                  <p>{redeemMessage}</p>
                </div>
              </div>
              <button className="secondary-button" type="button" onClick={resetFlow}>
                继续兑换下一张
              </button>
            </section>
          ) : null}
        </div>
      </section>

      {showConfirm ? (
        <div className="modal-backdrop" role="presentation">
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
            <button
              className="modal-close"
              type="button"
              onClick={() => setShowConfirm(false)}
              title="关闭确认窗口"
            >
              <X size={18} aria-hidden="true" />
            </button>
            <div className="modal-icon">
              <LockKeyhole size={26} aria-hidden="true" />
            </div>
            <h2 id="confirm-title">确认充值账户</h2>
            <p>请核对卡密、Token 和邮箱。确认后会立即调用兑换接口。</p>
            <dl className="confirm-list">
              <div>
                <dt>卡密</dt>
                <dd>{checkedCard ? maskValue(checkedCard.code_plain) : '-'}</dd>
              </div>
              <div>
                <dt>Token JSON</dt>
                <dd>{maskTokenPayload(normalizedToken)}</dd>
              </div>
              <div>
                <dt>充值账户 ID</dt>
                <dd>{getTokenAccountId(normalizedToken) || '-'}</dd>
              </div>
              <div>
                <dt>账户邮箱</dt>
                <dd>
                  <Mail size={16} aria-hidden="true" />
                  {getRechargeEmail(normalizedToken, clientEmail)}
                </dd>
              </div>
            </dl>
            <div className="button-row modal-actions">
              <button className="secondary-button" type="button" onClick={() => setShowConfirm(false)}>
                返回修改
              </button>
              <button className="primary-button danger" type="button" onClick={handleRedeem} disabled={redeemLoading}>
                {redeemLoading ? <Loader2 size={18} className="spin" /> : <Send size={18} />}
                <span>{redeemLoading ? '兑换中' : '确认充值'}</span>
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {showInventoryModal ? (
        <div className="modal-backdrop" role="presentation">
          <section className="modal inventory-modal" role="dialog" aria-modal="true" aria-labelledby="inventory-title">
            <button
              className="modal-close"
              type="button"
              onClick={() => setShowInventoryModal(false)}
              title="关闭库存窗口"
            >
              <X size={18} aria-hidden="true" />
            </button>
            <div className="modal-icon">
              <PackageCheck size={26} aria-hidden="true" />
            </div>
            <h2 id="inventory-title">库存查询</h2>
            <p>默认展示库存状态。输入授权码后可查看实际库存数量。</p>
            <div className="inventory-summary">
              <span>当前状态</span>
              <strong>{inventoryLoading ? '读取中' : inventory?.label ?? '库存未知'}</strong>
            </div>
            <label className="field">
              <span>库存授权码</span>
              <input
                value={inventorySecret}
                onChange={(event) => {
                  setInventorySecret(event.target.value);
                  setInventoryError('');
                  setInventoryAccessGranted(false);
                }}
                placeholder="请输入授权码"
                autoComplete="off"
              />
            </label>
            {inventoryError ? <div className="inline-error">{inventoryError}</div> : null}
            {inventoryAccessGranted && inventory ? (
              <div className="inventory-count-box">
                <span>实际库存</span>
                <strong>{inventory.count}</strong>
                <small>{inventory.status}</small>
              </div>
            ) : null}
            <div className="button-row modal-actions">
              <button className="secondary-button" type="button" onClick={loadInventory}>
                <RefreshCw size={18} className={inventoryLoading ? 'spin' : ''} aria-hidden="true" />
                刷新状态
              </button>
              <button className="primary-button" type="button" onClick={handleInventoryAccess}>
                查看实际库存
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {showAccountModal ? (
        <div className="modal-backdrop" role="presentation">
          <section className="modal account-modal" role="dialog" aria-modal="true" aria-labelledby="account-title">
            <button
              className="modal-close"
              type="button"
              onClick={() => setShowAccountModal(false)}
              title="关闭账号信息窗口"
            >
              <X size={18} aria-hidden="true" />
            </button>
            <div className="account-avatar">
              <UserCircle2 size={70} aria-hidden="true" />
            </div>
            <h2 id="account-title">确认登录状态</h2>
            <p className="account-copy">
              请确认您已在当前浏览器中登录 ChatGPT 账号；已登录请打开账号数据页，未登录请先前往登录。
            </p>
            <div className="modal-divider" />
            <div className="account-action-list">
              <button
                className="gradient-button blue"
                type="button"
                onClick={() => openExternal(CHATGPT_SESSION_URL)}
              >
                <ExternalLink size={19} aria-hidden="true" />
                已登录，打开数据页
              </button>
              <button
                className="gradient-button green"
                type="button"
                onClick={() => openExternal(OPENAI_LOGIN_URL)}
              >
                <LogIn size={19} aria-hidden="true" />
                前往登录
              </button>
              <button className="large-cancel-button" type="button" onClick={() => setShowAccountModal(false)}>
                <X size={18} aria-hidden="true" />
                取消
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
    </>
  );
}

export default App;
