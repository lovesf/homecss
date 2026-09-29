/** 控制台后端的 HTTP 接口。管理接口依赖登录后下发的 HttpOnly 会话 Cookie。 */
import type { CatalogueEntity, Season, ServerLayout } from './consoleClient';
import type { Accent } from './theme';

export interface AdminSettings {
  haUrl: string;
  hasToken: boolean;
  controlEnabled: boolean;
  dataSource: 'demo' | 'live';
  hasWeatherKey: boolean;
  weatherHost: string;
  weatherGeoHost: string;
  homeTitle: string;
  homeSubtitle: string;
  theme: 'dark' | 'light' | 'auto';
  tileScale: number;
  accent: Accent;
  /** 季节规则：启用后由控制台在 HA 中维护季节辅助元素与三条季节自动化。 */
  seasonRules: boolean;
  season: Season | null;
  seasonSync: { state: 'idle' | 'demo' | 'waiting' | 'syncing' | 'off' | 'ok' | 'pending' | 'error'; message: string };
}

export interface AuditEntry {
  time: string;
  event: string;
  ip: string;
  [key: string]: unknown;
}

export type FilterMode = 'blacklist' | 'whitelist';

export interface EntityFilter {
  mode: FilterMode;
  blacklist: string[];
  whitelist: string[];
}

/** 设置页用：全部已发现的实体（过滤前）及当前状态。 */
export interface DiscoveredEntities {
  filter: EntityFilter;
  rooms: { id: string; name: string }[];
  entities: (CatalogueEntity & { state: string | null })[];
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly body: Record<string, unknown> = {}) {
    super(message);
  }
}

export async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, '无法连接控制台服务');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, String(data.error ?? `请求失败（${response.status}）`), data);
  return data as T;
}

export type LoginResult = { ok: true } | { ok: false; message: string; retryAfter?: number };

export async function login(pin: string): Promise<LoginResult> {
  try {
    await request('/api/admin/login', 'POST', { pin });
    return { ok: true };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const retryAfter = typeof error.body.retryAfter === 'number' ? error.body.retryAfter : undefined;
    const remaining = typeof error.body.remaining === 'number' ? error.body.remaining : undefined;
    if (retryAfter) return { ok: false, message: `尝试次数过多，请 ${retryAfter} 秒后再试`, retryAfter };
    if (error.status === 401) return { ok: false, message: remaining !== undefined ? `密码不正确，还可尝试 ${remaining} 次` : '密码不正确' };
    return { ok: false, message: error.message };
  }
}

export const logout = () => request('/api/admin/logout', 'POST').catch(() => undefined);
export const getSettings = () => request<AdminSettings>('/api/admin/settings');
export const updateSettings = (patch: Partial<AdminSettings> & { haToken?: string; clearToken?: boolean; weatherKey?: string; clearWeatherKey?: boolean }) => request<AdminSettings>('/api/admin/settings', 'PUT', patch);
export const testWeather = () => request<{ ok: boolean; summary?: string; error?: string }>('/api/admin/weather/test', 'POST');
export const changePin = (pin: string) => request('/api/admin/pin', 'PUT', { pin });
export const getAudit = (limit = 30) => request<AuditEntry[]>(`/api/admin/audit?limit=${limit}`);
export const putLayout = (layout: ServerLayout) => request<ServerLayout>('/api/layout', 'PUT', layout);
export const getEntities = () => request<DiscoveredEntities>('/api/admin/entities');
export const putFilter = (filter: Partial<EntityFilter>) => request<DiscoveredEntities>('/api/admin/filter', 'PUT', filter);

/** HA 自动化（设置 → 自动化）；演示模式为服务内存中的演示数据。state 为 on / off / unavailable。 */
export interface AutomationItem {
  id: string;
  name: string;
  state: string | null;
  lastTriggered: string | null;
}

export interface AutomationList {
  source: 'demo' | 'live';
  /** HA 模式下是否已连接；未连接时列表为空。 */
  connected: boolean;
  automations: AutomationItem[];
}

export const getAutomations = () => request<AutomationList>('/api/admin/automations');
export const setAutomation = (id: string, enabled: boolean) => request<{ ok: true; id: string; state: string }>('/api/admin/automations', 'PUT', { id, enabled });
