import { Search } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { ApiError, getEntities, putFilter } from '../consoleApi';
import type { DiscoveredEntities, EntityFilter as Filter, FilterMode } from '../consoleApi';
import { entityKindLabel } from '../haAdapter';

interface EntityFilterProps {
  /** HA 已连接时才有发现结果；连接状态变化后重新读取。 */
  connected: boolean;
  onExpired: (message: string) => void;
}

const modeHints: Record<FilterMode, string> = {
  blacklist: '黑名单：发现的设备默认全部显示，勾选的加入黑名单，不在页面显示。',
  whitelist: '白名单：只显示勾选的设备，新发现的设备默认不显示。',
};

function isVisible(filter: Filter, id: string): boolean {
  return filter.mode === 'whitelist' ? filter.whitelist.includes(id) : !filter.blacklist.includes(id);
}

/** 勾选框表示“在当前模式的名单里”：黑名单勾选即不显示，白名单勾选即显示。 */
function inList(filter: Filter, id: string): boolean {
  return (filter.mode === 'whitelist' ? filter.whitelist : filter.blacklist).includes(id);
}

/** 把一批实体加入或移出当前模式的名单，另一份名单不变。 */
function withMembership(filter: Filter, ids: string[], member: boolean): Partial<Filter> {
  const key = filter.mode === 'whitelist' ? 'whitelist' : 'blacklist';
  const next = new Set(filter[key]);
  ids.forEach((id) => (member ? next.add(id) : next.delete(id)));
  return { [key]: [...next] };
}

/** 设备筛选：列出 HA 自动发现的全部实体，按黑名单或白名单决定哪些在控制台显示和可被控制。 */
export function EntityFilter({ connected, onExpired }: EntityFilterProps) {
  const searchId = useId();
  const [data, setData] = useState<DiscoveredEntities | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!connected) return;
    let active = true;
    getEntities()
      .then((loaded) => { if (active) setData(loaded); })
      .catch((reason: Error) => { if (!active) return; if (reason instanceof ApiError && reason.status === 401) onExpired(reason.message); else setError(reason.message); });
    return () => { active = false; };
  }, [connected, onExpired]);

  const groups = useMemo(() => {
    if (!data) return [];
    const keyword = query.trim().toLowerCase();
    const matches = data.entities.filter((entity) => !keyword || entity.name.toLowerCase().includes(keyword) || entity.id.toLowerCase().includes(keyword) || entityKindLabel(entity).includes(keyword));
    const rooms = [...data.rooms, { id: null, name: '未分配区域' }];
    return rooms
      .map((room) => ({ room, entities: matches.filter((entity) => entity.areaId === room.id) }))
      .filter((group) => group.entities.length > 0);
  }, [data, query]);

  async function save(patch: Partial<Filter>) {
    if (!data) return;
    const previous = data;
    setData({ ...data, filter: { ...data.filter, ...patch } });
    setError(null);
    try {
      setData(await putFilter(patch));
    } catch (reason) {
      setData(previous);
      if (reason instanceof ApiError && reason.status === 401) onExpired(reason.message);
      else setError(reason instanceof Error ? reason.message : '保存失败');
    }
  }

  if (!connected) return <p className="settings-message">连接 Home Assistant 后，这里会列出自动发现的设备。</p>;
  if (!data) return <p className="settings-message">{error ?? '正在读取已发现的设备…'}</p>;

  const filter = data.filter;
  const shown = data.entities.filter((entity) => isVisible(filter, entity.id)).length;
  const listed = groups.flatMap((group) => group.entities.map((entity) => entity.id));

  return (
    <div className="entity-filter">
      <div className="settings-row">
        <span>已发现 {data.entities.length} 个，页面显示 {shown} 个</span>
        <div className="settings-segmented" role="radiogroup" aria-label="过滤方式">
          {(['blacklist', 'whitelist'] as const).map((mode) => (
            <button key={mode} type="button" role="radio" aria-checked={filter.mode === mode} onClick={() => { if (mode !== filter.mode) void save({ mode }); }}>{mode === 'blacklist' ? '黑名单' : '白名单'}</button>
          ))}
        </div>
      </div>
      <p className="settings-message">{modeHints[filter.mode]}只有当前模式的名单生效，{filter.mode === 'whitelist' ? '黑名单' : '白名单'}此时不起作用（其中的勾选会保留，切回时恢复）；不显示的设备在列表中变暗。</p>
      <div className="entity-filter__tools">
        <label className="entity-filter__search" htmlFor={searchId}>
          <Search size={16} />
          <input id={searchId} type="search" placeholder="搜索名称、实体 ID 或类型" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <button type="button" className="small-button" onClick={() => save(withMembership(filter, listed, true))} disabled={listed.length === 0}>全部勾选</button>
        <button type="button" className="small-button" onClick={() => save(withMembership(filter, listed, false))} disabled={listed.length === 0}>全部取消</button>
      </div>
      {error && <p className="settings-message settings-message--error" role="alert">{error}</p>}
      {groups.length === 0 ? <p className="settings-message">没有匹配的设备</p> : groups.map(({ room, entities }) => (
        <section key={room.id ?? '_unassigned'} className="entity-filter__group">
          <h4>{room.name}<em>显示 {entities.filter((entity) => isVisible(filter, entity.id)).length} / {entities.length}</em></h4>
          <ul>
            {entities.map((entity) => {
              const visible = isVisible(filter, entity.id);
              const member = inList(filter, entity.id);
              return (
                <li key={entity.id} className={visible ? undefined : 'entity-filter__row--hidden'}>
                  <label title={visible ? '页面显示' : '页面不显示'}>
                    <input type="checkbox" checked={member} onChange={() => save(withMembership(filter, [entity.id], !member))} aria-description={filter.mode === 'whitelist' ? '勾选即加入白名单，在页面显示' : '勾选即加入黑名单，不在页面显示'} />
                    <span className="entity-filter__name">{entity.name}</span>
                    <span className="entity-filter__kind">{entityKindLabel(entity)}</span>
                    <span className="entity-filter__state">{entity.state ?? '—'}</span>
                    <code>{entity.id}</code>
                  </label>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
