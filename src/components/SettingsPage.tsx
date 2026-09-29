import { CloudSun, Grid2x2, History, KeyRound, LayoutTemplate, ListChecks, Lock, Minus, Palette, Plus, RotateCcw, Server, ShieldCheck, Sun, Workflow } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import type { CSSProperties, FormEvent, KeyboardEvent } from 'react';
import type { LucideIcon } from 'lucide-react';
import { ApiError, changePin, getAudit, getSettings, testWeather, updateSettings } from '../consoleApi';
import type { AdminSettings, AuditEntry } from '../consoleApi';
import type { ServerStatus } from '../consoleClient';
import { ACCENTS } from '../theme';
import { AutomationList } from './AutomationList';
import { connectionText } from './ConnectionBadge';
import { EntityFilter } from './EntityFilter';

interface SettingsPageProps {
  status: ServerStatus | null;
  onLock: () => void;
  /** 会话过期或后端拒绝时退回，并提示原因。 */
  onExpired: (message: string) => void;
}

type Message = { tone: 'good' | 'error'; text: string } | null;

const defaultHomeTitle = '我的家庭';
const defaultHomeSubtitle = '常用设备与正在运行的设备，一眼看清';
const digitsOnly = (value: string) => value.replace(/\D/g, '').slice(0, 4);
const auditLabels: Record<string, string> = {
  login: '管理登录',
  login_failed: '密码错误',
  settings_changed: '修改设置',
  pin_changed: '修改管理密码',
  layout_changed: '修改布局',
  filter_changed: '修改设备筛选',
  automation_toggled: '开关自动化',
  season_rules_synced: '同步季节规则',
  service_call: '设备控制',
};

type Tab = 'connection' | 'devices' | 'automations' | 'display' | 'security' | 'audit';

const tabs: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: 'connection', label: '连接', icon: Server },
  { id: 'devices', label: '设备', icon: ListChecks },
  { id: 'automations', label: '自动化', icon: Workflow },
  { id: 'display', label: '显示', icon: LayoutTemplate },
  { id: 'security', label: '安全', icon: KeyRound },
  { id: 'audit', label: '记录', icon: History },
];

function FormMessage({ message }: { message: Message }) {
  return <p className={`settings-message${message ? ` settings-message--${message.tone}` : ''}`} role="status">{message?.text}</p>;
}

function auditDetail(entry: AuditEntry): string {
  if (entry.event === 'service_call') return `${String(entry.entity)} · ${String(entry.service)}${entry.ok ? '' : ` · 失败：${String(entry.error)}`}`;
  if (entry.event === 'season_rules_synced') return ['created', 'updated', 'deleted'].map((key) => [key, entry[key]] as const).filter(([, ids]) => Array.isArray(ids) && ids.length).map(([key, ids]) => `${{ created: '创建', updated: '更新', deleted: '删除' }[key]} ${(ids as string[]).join('、')}`).join('；');
  if (entry.event === 'automation_toggled') return `${String(entry.entity)} · ${entry.enabled ? '开启' : '关闭'}${entry.ok ? '' : ` · 失败：${String(entry.error)}`}`;
  if (entry.event === 'filter_changed') return `${entry.mode === 'whitelist' ? '白名单' : '黑名单'}（黑名单 ${String(entry.blacklist)} 项，白名单 ${String(entry.whitelist)} 项）`;
  if (entry.event === 'settings_changed' && Array.isArray(entry.fields)) return entry.fields.join('、');
  if (entry.event === 'login_failed' && entry.locked_seconds) return `锁定 ${String(entry.locked_seconds)} 秒`;
  return '';
}

/** 管理设置；由管理密码弹窗登录后进入，所有设置保存在控制台后端，离开页面即退出登录。 */
export function SettingsPage({ status, onLock, onExpired }: SettingsPageProps) {
  const formId = useId();
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [haUrl, setHaUrl] = useState('');
  const [haToken, setHaToken] = useState('');
  const [controlMessage, setControlMessage] = useState<Message>(null);
  const [connectionMessage, setConnectionMessage] = useState<Message>(null);
  const [weatherKey, setWeatherKey] = useState('');
  const [weatherHost, setWeatherHost] = useState('');
  const [weatherGeoHost, setWeatherGeoHost] = useState('');
  const [weatherMessage, setWeatherMessage] = useState<Message>(null);
  const [testingWeather, setTestingWeather] = useState(false);
  const [homeTitle, setHomeTitle] = useState('');
  const [homeSubtitle, setHomeSubtitle] = useState('');
  const [displayMessage, setDisplayMessage] = useState<Message>(null);
  const [themeMessage, setThemeMessage] = useState<Message>(null);
  // 格子大小：拖动时本地先显示数值，停下 400ms 后保存；保存后服务推送给所有屏幕。
  const [tileScale, setTileScale] = useState<number | null>(null);
  const [scaleMessage, setScaleMessage] = useState<Message>(null);
  const [seasonMessage, setSeasonMessage] = useState<Message>(null);
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [pinMessage, setPinMessage] = useState<Message>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [tab, setTab] = useState<Tab>('connection');

  useEffect(() => {
    let active = true;
    getSettings()
      .then((loaded) => { if (active) { setSettings(loaded); setHaUrl(loaded.haUrl); setWeatherHost(loaded.weatherHost); setWeatherGeoHost(loaded.weatherGeoHost); setHomeTitle(loaded.homeTitle); setHomeSubtitle(loaded.homeSubtitle); setTileScale(loaded.tileScale ?? 100); } })
      .catch((error: Error) => { if (active) onExpired(error.message); });
    getAudit().then((entries) => { if (active) setAudit(entries); }).catch(() => undefined);
    return () => { active = false; };
  }, [onExpired]);

  useEffect(() => {
    if (tileScale === null || !settings || tileScale === (settings.tileScale ?? 100)) return;
    const timer = window.setTimeout(() => { void save({ tileScale }, setScaleMessage, `格子大小已设为 ${tileScale}%`); }, 400);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在滑杆数值变化时保存
  }, [tileScale]);

  // 季节规则由服务异步同步到 HA：停留在“自动化”标签时定时刷新同步状态。
  useEffect(() => {
    if (tab !== 'automations') return;
    const timer = window.setInterval(() => { getSettings().then(setSettings).catch(() => undefined); }, 3000);
    return () => window.clearInterval(timer);
  }, [tab]);

  /** 格子大小按 1% 微调，限制在 80%–120%。 */
  function changeTileScale(delta: number) {
    setTileScale((current) => Math.min(120, Math.max(80, (current ?? 100) + delta)));
    setScaleMessage(null);
  }

  /** 统一处理保存：会话过期时退出设置页，其他错误显示在对应区块。 */
  async function save(patch: Parameters<typeof updateSettings>[0], show: (message: Message) => void, success: string): Promise<boolean> {
    try {
      const next = await updateSettings(patch);
      setSettings(next);
      show({ tone: 'good', text: success });
      getAudit().then(setAudit).catch(() => undefined);
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onExpired(error.message);
      else show({ tone: 'error', text: error instanceof Error ? error.message : '保存失败' });
      return false;
    }
  }

  async function saveConnection(event: FormEvent) {
    event.preventDefault();
    const patch = haToken.trim() ? { haUrl, haToken: haToken.trim() } : { haUrl };
    if (await save(patch, setConnectionMessage, '已保存到控制台服务')) setHaToken('');
  }

  async function saveWeather(event: FormEvent) {
    event.preventDefault();
    const patch = { weatherHost, weatherGeoHost, ...(weatherKey.trim() ? { weatherKey: weatherKey.trim() } : {}) };
    if (await save(patch, setWeatherMessage, '已保存到控制台服务')) setWeatherKey('');
  }

  async function checkWeather() {
    setTestingWeather(true);
    setWeatherMessage(null);
    try {
      const result = await testWeather();
      setWeatherMessage(result.ok ? { tone: 'good', text: `可用：${result.summary}` } : { tone: 'error', text: result.error ?? '测试失败' });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onExpired(error.message);
      else setWeatherMessage({ tone: 'error', text: error instanceof Error ? error.message : '测试失败' });
    } finally {
      setTestingWeather(false);
    }
  }

  async function saveDisplay(event: FormEvent) {
    event.preventDefault();
    await save({ homeTitle, homeSubtitle }, setDisplayMessage, '已保存，所有屏幕立即更新');
  }

  async function resetDisplay() {
    setHomeTitle(defaultHomeTitle);
    setHomeSubtitle(defaultHomeSubtitle);
    await save({ homeTitle: defaultHomeTitle, homeSubtitle: defaultHomeSubtitle }, setDisplayMessage, '已恢复默认');
  }

  async function savePin(event: FormEvent) {
    event.preventDefault();
    if (newPin.length !== 4) { setPinMessage({ tone: 'error', text: '新密码需为 4 位数字' }); return; }
    if (newPin !== confirmPin) { setPinMessage({ tone: 'error', text: '两次输入不一致' }); return; }
    try {
      await changePin(newPin);
      setNewPin('');
      setConfirmPin('');
      setPinMessage({ tone: 'good', text: '管理密码已更新' });
      getAudit().then(setAudit).catch(() => undefined);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onExpired(error.message);
      else setPinMessage({ tone: 'error', text: error instanceof Error ? error.message : '修改失败' });
    }
  }

  /** 切换标签；打开“记录”时重新读取，保证看到最新记录。 */
  function selectTab(next: Tab) {
    setTab(next);
    if (next === 'audit') getAudit().then(setAudit).catch(() => undefined);
  }

  /** 标签栏方向键切换（WAI-ARIA 标签页模式）。 */
  function handleTabKey(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const index = tabs.findIndex((item) => item.id === tab);
    const next = tabs[(index + step + tabs.length) % tabs.length].id;
    selectTab(next);
    document.getElementById(`${formId}-tab-${next}`)?.focus();
  }

  if (!settings) return <div className="settings"><p className="settings-message">正在读取设置…</p></div>;

  const live = settings.dataSource === 'live';
  const [liveTone, liveText] = connectionText(status?.ha ?? null);
  const connected = live && status?.ha.kind === 'connected';

  return (
    <div className="settings">
      <div className="settings-tabs-bar">
        <div className="settings-tabs" role="tablist" aria-label="设置分组" onKeyDown={handleTabKey}>
          {tabs.map(({ id, label, icon: Icon }) => (
            <button key={id} id={`${formId}-tab-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls={`${formId}-panel`} tabIndex={tab === id ? 0 : -1} onClick={() => selectTab(id)}>
              <Icon size={16} />{label}
            </button>
          ))}
        </div>
        <button type="button" className="small-button" onClick={onLock}><Lock size={15} />锁定并返回</button>
      </div>

      <div id={`${formId}-panel`} className="settings-panel" role="tabpanel" aria-labelledby={`${formId}-tab-${tab}`}>
        {tab === 'connection' && <>
          <form className="settings-card" onSubmit={saveConnection}>
            <div className="settings-card__heading"><span className="tile__chip"><Server size={20} /></span><div><h3>Home Assistant 连接</h3><p>地址和令牌保存在控制台服务，令牌加密存储且不会发给浏览器；由服务统一连接 HA。</p></div></div>
            <div className="settings-row">
              <span id={`${formId}-source`}>数据来源</span>
              <div className="settings-segmented" role="radiogroup" aria-labelledby={`${formId}-source`}>
                {([['demo', '演示数据'], ['live', 'Home Assistant']] as const).map(([value, label]) => (
                  <button key={value} type="button" role="radio" aria-checked={settings.dataSource === value} onClick={() => { if (value !== settings.dataSource) void save({ dataSource: value }, setConnectionMessage, value === 'live' ? '已切换到 Home Assistant' : '已切换到演示数据'); }}>{label}</button>
                ))}
              </div>
            </div>
            {live && <p className={`settings-status settings-status--${liveTone}`} role="status">{liveText}</p>}
            <label className="settings-field">
              <span>HA 地址</span>
              <input type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder="http://192.168.1.10:8123" value={haUrl} onChange={(event) => setHaUrl(event.target.value)} />
            </label>
            <label className="settings-field">
              <span>长期访问令牌</span>
              <input type="password" autoComplete="off" spellCheck={false} placeholder={settings.hasToken ? '已保存，留空则保持不变' : '在 HA 个人资料 → 安全 中创建'} value={haToken} onChange={(event) => setHaToken(event.target.value)} />
            </label>
            <div className="settings-actions">
              <button type="submit" className="small-button small-button--selected">保存连接设置</button>
              {settings.hasToken && <button type="button" className="small-button" onClick={() => save({ clearToken: true }, setConnectionMessage, '已清除令牌并切回演示数据')}>清除令牌</button>}
              <FormMessage message={connectionMessage} />
            </div>
          </form>

          <form className="settings-card" onSubmit={saveWeather}>
            <div className="settings-card__heading"><span className="tile__chip"><CloudSun size={20} /></span><div><h3>和风天气</h3><p>天气页的实时天气与 7 天预报由控制台服务向和风天气查询，密钥加密存储且不会发给浏览器。Host 在和风控制台“设置”中查看，留空使用公共地址。</p></div></div>
            <label className="settings-field">
              <span>API KEY</span>
              <input type="password" autoComplete="off" spellCheck={false} placeholder={settings.hasWeatherKey ? '已保存，留空则保持不变' : '在和风控制台 项目管理 → 凭据 中创建'} value={weatherKey} onChange={(event) => setWeatherKey(event.target.value)} />
            </label>
            <div className="settings-field-row">
              <label className="settings-field">
                <span>API Host</span>
                <input type="text" inputMode="url" autoComplete="off" spellCheck={false} placeholder="api.qweather.com" value={weatherHost} onChange={(event) => setWeatherHost(event.target.value)} />
              </label>
              <label className="settings-field">
                <span>城市搜索 Host</span>
                <input type="text" inputMode="url" autoComplete="off" spellCheck={false} placeholder="geoapi.qweather.com" value={weatherGeoHost} onChange={(event) => setWeatherGeoHost(event.target.value)} />
              </label>
            </div>
            <div className="settings-actions">
              <button type="submit" className="small-button small-button--selected">保存天气设置</button>
              <button type="button" className="small-button" onClick={checkWeather} disabled={testingWeather}>{testingWeather ? '测试中…' : '测试'}</button>
              {settings.hasWeatherKey && <button type="button" className="small-button" onClick={() => save({ clearWeatherKey: true }, setWeatherMessage, '已清除和风天气密钥')}>清除密钥</button>}
              <FormMessage message={weatherMessage} />
            </div>
          </form>
        </>}

        {tab === 'devices' && <>
          <section className="settings-card">
            <div className="settings-card__heading"><span className="tile__chip"><ShieldCheck size={20} /></span><div><h3>设备控制</h3><p>关闭后所有屏幕只能查看状态：设备按钮点击无效，编辑布局与常用设备隐藏，控制台服务也会拒绝控制请求。</p></div></div>
            <div className="settings-row">
              <span id={`${formId}-control`}>允许控制设备</span>
              <button type="button" role="switch" className="settings-switch" aria-checked={settings.controlEnabled} aria-labelledby={`${formId}-control`} onClick={() => save({ controlEnabled: !settings.controlEnabled }, setControlMessage, settings.controlEnabled ? '已切换为只读模式' : '已允许控制设备')}><span /></button>
            </div>
            <FormMessage message={controlMessage} />
          </section>

          <section className="settings-card">
            <div className="settings-card__heading"><span className="tile__chip"><ListChecks size={20} /></span><div><h3>设备筛选</h3><p>控制台自动发现 HA 中的灯、温控、播放器、人员和常用传感器，房间取自 HA 区域。这里决定哪些在页面显示；未显示的设备控制台服务也不允许控制。在 HA 中隐藏或禁用的实体不参与发现。</p></div></div>
            <EntityFilter connected={Boolean(connected)} onExpired={onExpired} />
          </section>
        </>}

        {tab === 'automations' && <>
          <section className="settings-card">
            <div className="settings-card__heading"><span className="tile__chip"><Sun size={20} /></span><div><h3>季节规则</h3><p>启用后，控制台用 HA 令牌在 HA 中创建并维护“控制台-季节”辅助元素和三条自动化：夏季地暖一打开就关闭；夏季空调从关闭开成制热时改为制冷；冬季空调从关闭开成制冷时改为制热。送风、除湿等模式不处理。关闭后删除这三条自动化（保留季节辅助元素）。</p></div></div>
            <div className="settings-row">
              <span id={`${formId}-season-rules`}>启用季节规则</span>
              <button type="button" role="switch" className="settings-switch" aria-checked={settings.seasonRules} aria-labelledby={`${formId}-season-rules`} onClick={() => { setSeasonMessage(null); void save({ seasonRules: !settings.seasonRules }, (message) => { if (message?.tone === 'error') setSeasonMessage(message); }, ''); }}><span /></button>
            </div>
            {settings.seasonRules && (
              <div className="settings-row">
                <span id={`${formId}-season`}>当前季节</span>
                <div className="settings-segmented" role="radiogroup" aria-labelledby={`${formId}-season`}>
                  {([['summer', '夏季'], ['winter', '冬季']] as const).map(([value, label]) => (
                    <button key={value} type="button" role="radio" aria-checked={settings.season === value} disabled={!settings.season && settings.dataSource === 'live'} onClick={() => { if (value !== settings.season) void save({ season: value }, setSeasonMessage, `已切换为${label}`); }}>{label}</button>
                  ))}
                </div>
              </div>
            )}
            {settings.seasonSync.message && <p className={`automation-list__note${settings.seasonSync.state === 'error' ? ' automation-list__note--error' : settings.seasonSync.state === 'ok' ? ' automation-list__note--good' : ''}`} role="status">{settings.seasonSync.state === 'error' ? '同步失败：' : ''}{settings.seasonSync.message}</p>}
            <FormMessage message={seasonMessage} />
          </section>

          <section className="settings-card">
            <div className="settings-card__heading"><span className="tile__chip"><Workflow size={20} /></span><div><h3>自动化</h3><p>同步 Home Assistant 中的自动化，可逐个开启或关闭；这里只切换开关，不修改自动化内容。每次切换都会写入操作记录。</p></div></div>
            <AutomationList canControl={settings.controlEnabled} onExpired={onExpired} />
          </section>
        </>}

        {tab === 'display' && <>
          <section className="settings-card">
            <div className="settings-card__heading"><span className="tile__chip"><Palette size={20} /></span><div><h3>主题</h3><p>所有屏幕共用。强调色用于选中状态、主按钮和导航高亮；灯光光晕、冷暖色和告警色按含义保持不变。自动：日出到日落使用浅色，其余时间深色；日出、日落取自该屏幕所选位置的天气，没有天气时按 06:00 与 18:00。</p></div></div>
            <div className="settings-row">
              <span id={`${formId}-theme`}>主题</span>
              <div className="settings-segmented" role="radiogroup" aria-labelledby={`${formId}-theme`}>
                {([['light', '浅色'], ['dark', '深色'], ['auto', '自动']] as const).map(([value, label]) => (
                  <button key={value} type="button" role="radio" aria-checked={settings.theme === value} onClick={() => { if (value !== settings.theme) void save({ theme: value }, setThemeMessage, `已切换为${label}`); }}>{label}</button>
                ))}
              </div>
            </div>
            <div className="settings-row settings-row--accent">
              <span id={`${formId}-accent`}>强调色</span>
              <div className="settings-accents" role="radiogroup" aria-labelledby={`${formId}-accent`}>
                {ACCENTS.map(({ value, label, swatch }) => {
                  const current = (settings.accent ?? 'amber') === value;
                  return (
                    <button key={value} type="button" role="radio" aria-checked={current} aria-label={label} title={label} style={{ '--swatch': swatch } as CSSProperties} onClick={() => { if (!current) void save({ accent: value }, setThemeMessage, `强调色已切换为${label}`); }}>
                      <span aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
            </div>
            <FormMessage message={themeMessage} />
          </section>

          <section className="settings-card">
            <div className="settings-card__heading"><span className="tile__chip"><Grid2x2 size={20} /></span><div><h3>格子大小</h3><p>所有屏幕共用。设备卡片连同文字、按钮一起按比例缩放；格子变小后同一行能放下更多卡片。</p></div></div>
            <div className="settings-scale">
              <label htmlFor={`${formId}-scale`}>缩放</label>
              <div className="settings-scale__control">
                <button type="button" className="icon-button" onClick={() => changeTileScale(-1)} disabled={(tileScale ?? 100) <= 80} aria-label="缩小 1%"><Minus size={16} /></button>
                <input id={`${formId}-scale`} type="range" min="80" max="120" step="1" value={tileScale ?? 100} onChange={(event) => { setTileScale(Number(event.target.value)); setScaleMessage(null); }} />
                <button type="button" className="icon-button" onClick={() => changeTileScale(1)} disabled={(tileScale ?? 100) >= 120} aria-label="放大 1%"><Plus size={16} /></button>
              </div>
              <output htmlFor={`${formId}-scale`}>{tileScale ?? 100}%</output>
              <button type="button" className="text-button" onClick={() => { setTileScale(100); setScaleMessage(null); }} disabled={(tileScale ?? 100) === 100}><RotateCcw size={14} />100%</button>
            </div>
            <FormMessage message={scaleMessage} />
          </section>

          <form className="settings-card" onSubmit={saveDisplay}>
            <div className="settings-card__heading"><span className="tile__chip"><LayoutTemplate size={20} /></span><div><h3>首页文字</h3><p>首页的标题和下面的一句话，所有屏幕共用。标题同时作为导航中的首页名称；副标题留空则不显示。</p></div></div>
            <div className="settings-field-row">
              <label className="settings-field">
                <span>标题</span>
                <input type="text" autoComplete="off" maxLength={12} placeholder={defaultHomeTitle} value={homeTitle} onChange={(event) => { setHomeTitle(event.target.value); setDisplayMessage(null); }} />
              </label>
              <label className="settings-field">
                <span>副标题</span>
                <input type="text" autoComplete="off" maxLength={60} placeholder="留空则不显示" value={homeSubtitle} onChange={(event) => { setHomeSubtitle(event.target.value); setDisplayMessage(null); }} />
              </label>
            </div>
            <div className="settings-actions">
              <button type="submit" className="small-button small-button--selected">保存</button>
              <button type="button" className="small-button" onClick={resetDisplay}>恢复默认</button>
              <FormMessage message={displayMessage} />
            </div>
          </form>
        </>}

        {tab === 'security' && (
          <form className="settings-card" onSubmit={savePin}>
            <div className="settings-card__heading"><span className="tile__chip"><KeyRound size={20} /></span><div><h3>管理密码</h3><p>进入设置时需要输入，4 位数字；控制台服务只保存哈希，连续输错会暂时锁定。</p></div></div>
            <div className="settings-field-row">
              <label className="settings-field">
                <span>新密码</span>
                <input type="password" inputMode="numeric" autoComplete="off" maxLength={4} value={newPin} onChange={(event) => { setNewPin(digitsOnly(event.target.value)); setPinMessage(null); }} />
              </label>
              <label className="settings-field">
                <span>再次输入</span>
                <input type="password" inputMode="numeric" autoComplete="off" maxLength={4} value={confirmPin} onChange={(event) => { setConfirmPin(digitsOnly(event.target.value)); setPinMessage(null); }} />
              </label>
            </div>
            <div className="settings-actions">
              <button type="submit" className="small-button small-button--selected">修改密码</button>
              <FormMessage message={pinMessage} />
            </div>
          </form>
        )}

        {tab === 'audit' && (
          <section className="settings-card">
            <div className="settings-card__heading"><span className="tile__chip"><History size={20} /></span><div><h3>操作记录</h3><p>最近 30 条登录、设置、布局与设备控制记录；不包含令牌和密码。</p></div></div>
            {audit.length === 0 ? <p className="settings-message">暂无记录</p> : (
              <ul className="settings-audit">
                {audit.map((entry, index) => (
                  <li key={`${entry.time}-${index}`} className={entry.event === 'login_failed' || entry.ok === false ? 'settings-audit__row--warn' : undefined}>
                    <time>{entry.time.replace('T', ' ').slice(5, 19)}</time>
                    <strong>{auditLabels[entry.event] ?? entry.event}</strong>
                    <span>{auditDetail(entry)}</span>
                    <small>{entry.ip}</small>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
