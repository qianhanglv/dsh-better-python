/**
 * Browser half of dsh-better-python.
 *
 * Adds the configuration section to the bundle's page in the Plugins view:
 *   - the mirror list (added, edited, deleted here; no "default" is chosen here)
 *   - extra pip flags the user allows
 *   - the fallback answer applied when a confirmation dialog times out
 *
 * The chosen install source belongs to the confirmation dialog, not to this
 * page: this page only maintains the list it offers.
 */
window.__ModuleLoader__.load({
  id: 'dsh-better-python',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace registered by this module. */
    const NS = 'pythonEnvGuard'

    /** Settings namespace: the Host row id declared by the bundle patch. */
    const ENTRY_ID = 'python-env-guard'

    /** Keyed by the bundle's package name on its Plugins page. */
    const BUNDLE = 'dsh-better-python'

    /** Must match BUILTIN_SOURCES in index.js. */
    const BUILTIN_SOURCES = [
      { label: '默认源（不指定）', url: null },
      { label: '清华 TUNA', url: 'https://pypi.tuna.tsinghua.edu.cn/simple' },
      { label: '阿里云', url: 'https://mirrors.aliyun.com/pypi/simple/' },
      { label: '中科大 USTC', url: 'https://pypi.mirrors.ustc.edu.cn/simple/' },
      { label: '腾讯云', url: 'https://mirrors.cloud.tencent.com/pypi/simple' },
      { label: '豆瓣', url: 'https://pypi.douban.com/simple/' },
    ]

    const zh = {
      sourcesTitle: '镜像源',
      sourcesHint: '此页只维护源列表。具体用哪个源，在安装确认弹窗里选择。',
      nameColumn: '名称',
      urlColumn: 'URL（留空表示 pip 默认渠道）',
      addSource: '添加源',
      save: '保存',
      saved: '已保存',
      unsaved: '有未保存的修改',
      remove: '删除',
      labelPlaceholder: '例如：清华 TUNA',
      urlPlaceholder: 'https://mirror.example.com/simple/',
      invalidLabel: '存在没有名称的源，无法保存。',
      invalidUrl: '存在无效的 URL（仅接受 http/https），无法保存。',
      emptyList: '源列表不能为空，至少保留一条。',
      extraFlags: '额外的 pip 参数',
      extraFlagsPlaceholder: '例如：--only-binary=:all:',
      extraFlagsHint: '空格分隔，例如 --only-binary=:all: --config-settings=--build-option=1。改安装源或安装目标的参数（-i、--index-url、--find-links、--target、--user、--break-system-packages 等）永远不允许，填了也不生效。',
      autoTitle: '默认回答',
      autoEnable: '30 秒内未回应时，自动执行下面的选项',
      autoHint: '仅在勾选后生效。倒计时结束仍未选择时，按这里的设置执行。',
      autoActionLabel: '默认动作',
      autoInstall: '安装',
      autoCancel: '取消安装',
      autoSourceLabel: '默认安装源',
      autoSourceMissing: '（未选择）',
      autoUninstallLabel: '默认卸载动作',
      autoUninstallRemove: '确认卸载',
      autoUninstallKeep: '保留，不卸载',
      loading: '正在读取当前设置…',
      unavailable: '无法读取该插件的配置：可能是设置服务未就绪，或当前配置文件不可写。',
      readOnly: '当前配置文件为只读，无法保存。',
      refused: 'Host 没有接受这个值。',
      noticeTitle: '自动执行的默认操作',
      noticeClear: '清除',
    }

    const en = {
      sourcesTitle: 'Mirrors',
      sourcesHint: 'This page only maintains the list. Which mirror to use is chosen in the install confirmation dialog.',
      nameColumn: 'Name',
      urlColumn: 'URL (empty means the pip default)',
      addSource: 'Add source',
      save: 'Save',
      saved: 'Saved',
      unsaved: 'Unsaved changes',
      remove: 'Remove',
      labelPlaceholder: 'e.g. Tsinghua TUNA',
      urlPlaceholder: 'https://mirror.example.com/simple/',
      invalidLabel: 'A source has no name, so it cannot be saved.',
      invalidUrl: 'A URL is invalid (http/https only), so it cannot be saved.',
      emptyList: 'The list cannot be empty; keep at least one source.',
      extraFlags: 'Extra pip flags',
      extraFlagsPlaceholder: 'e.g. --only-binary=:all:',
      extraFlagsHint: 'Space-separated. Flags that change the install source or target (-i, --index-url, --find-links, --target, --user, --break-system-packages) are never allowed.',
      autoTitle: 'Fallback answer',
      autoEnable: 'Apply the options below when no answer arrives within 30 seconds',
      autoHint: 'Only active while checked. When the countdown ends, this choice runs.',
      autoActionLabel: 'Default action',
      autoInstall: 'Install',
      autoCancel: 'Cancel',
      autoSourceLabel: 'Default mirror',
      autoSourceMissing: '(not chosen)',
      autoUninstallLabel: 'Default uninstall action',
      autoUninstallRemove: 'Uninstall',
      autoUninstallKeep: 'Keep it',
      loading: 'Reading the current value…',
      unavailable: 'Cannot read this plugin configuration: the settings service is unavailable or the profile is read-only.',
      readOnly: 'This profile stores settings read-only.',
      refused: 'The Host did not accept that value.',
      noticeTitle: 'Actions taken automatically',
      noticeClear: 'Clear',
    }

    const LABEL_WIDTH = 118
    const GAP = 12
    const stack = { display: 'flex', flexDirection: 'column', gap: 16, padding: '12px 0' }
    const field = { display: 'flex', flexDirection: 'column', gap: 6 }
    const row = { display: 'flex', alignItems: 'center', gap: GAP }
    const label = { color: 'var(--dsw-alias-label-primary)', fontSize: 13, width: LABEL_WIDTH, flex: `0 0 ${LABEL_WIDTH}px` }
    const hint = { color: 'var(--dsw-alias-label-caption)', fontSize: 12, margin: 0 }
    const note = { ...hint, marginLeft: LABEL_WIDTH + GAP }
    const control = {
      font: 'inherit',
      color: 'var(--dsw-alias-label-primary)',
      background: 'var(--dsw-alias-bg-layer-1)',
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: 6,
      padding: '4px 8px',
      boxSizing: 'border-box',
    }
    const wide = { ...control, width: 380, maxWidth: '100%' }
    const button = {
      font: 'inherit',
      fontSize: 12,
      color: 'var(--dsw-alias-label-primary)',
      background: 'var(--dsw-alias-bg-layer-1)',
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: 6,
      padding: '4px 10px',
      cursor: 'pointer',
    }
    const removeButton = { ...button, padding: '2px 8px', color: 'var(--dsw-alias-label-caption)' }
    const errorText = { ...hint, color: 'var(--dsw-alias-state-error-primary)' }
    const strip = {
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      width: '100%',
      maxWidth: 'var(--dsh-composer-card-max-width)',
      padding: '8px 12px',
      margin: '0 auto 6px',
      maxHeight: 160,
      overflowY: 'auto',
      boxSizing: 'border-box',
      background: 'var(--dsw-alias-bg-layer-1)',
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: 10,
    }
    const stripHead = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }
    const stripTitle = { ...hint, fontWeight: 600, margin: 0 }
    const stripLine = { ...hint, margin: 0, fontSize: 12, lineHeight: 1.4 }

    /**
     * Parse the stored JSON list; an empty or unusable value falls back to the
     * built-ins, matching the Host.
     * @param raw - the stored string.
     * @returns A fresh array of sources.
     */
    function parseSources(raw) {
      if (typeof raw !== 'string' || raw.trim().length === 0) return BUILTIN_SOURCES.map(source => ({ ...source }))
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        return BUILTIN_SOURCES.map(source => ({ ...source }))
      }
      if (!Array.isArray(parsed)) return BUILTIN_SOURCES.map(source => ({ ...source }))
      const out = []
      for (const item of parsed) {
        if (item === null || typeof item !== 'object') continue
        const name = typeof item.label === 'string' ? item.label : ''
        if (name.trim().length === 0) continue
        const url = typeof item.url === 'string' && item.url.trim().length > 0 ? item.url.trim() : null
        out.push({ label: name, url })
      }
      return out.length > 0 ? out : BUILTIN_SOURCES.map(source => ({ ...source }))
    }

    /**
     * Whether a string is an acceptable index URL.
     * @param value - candidate URL.
     * @returns True for http(s) URLs.
     */
    function validUrl(value) {
      try {
        const url = new URL(value)
        return url.protocol === 'http:' || url.protocol === 'https:'
      } catch {
        return false
      }
    }

    /**
     * Parse the stored notice list.
     * @param raw - the stored string.
     * @returns Notices, newest first.
     */
    function parseNotices(raw) {
      if (typeof raw !== 'string' || raw.trim().length === 0) return []
      try {
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        return parsed
          .filter(item => item !== null && typeof item === 'object' && typeof item.text === 'string')
          .sort((left, right) => {
            const a = Number(left.id)
            const b = Number(right.id)
            if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
            return a - b
          })
      } catch {
        return []
      }
    }

    /**
     * Strip above the composer listing actions the plugin took without an answer.
     * @param props - slot props, plus the config form this module resolved.
     */
    function NoticeStrip(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const form = props.form
      const snapshot = useSnapshot(form)
      const notices = parseNotices(snapshot === undefined ? '' : (snapshot.value ?? {}).notices)
      if (notices.length === 0) return null

      const clear = () => {
        if (form === undefined || typeof form.mutate !== 'function') return
        Promise.resolve(form.mutate([{ op: 'set', path: ['notices'], value: '' }], snapshot.revision)).catch(() => {})
      }

      return h('div', { style: strip, role: 'status' },
        h('div', { style: stripHead },
          h('span', { style: stripTitle }, t('noticeTitle')),
          h('button', {
            type: 'button',
            style: { ...button, padding: '0 6px', fontSize: 11, lineHeight: '18px' },
            onClick: clear,
          }, t('noticeClear'))),
        notices.map(notice => h('p', { key: notice.id ?? notice.text, style: stripLine }, notice.text)))
    }

    /**
     * Subscribe to a Host config form's accepted snapshot.
     * @param form - the ConfigForm for this row, or undefined when unavailable.
     * @returns The current snapshot, or undefined.
     */
    function useSnapshot(form) {
      const subscribe = React.useCallback(
        listener => (form === undefined ? () => {} : form.subscribe(listener)),
        [form],
      )
      const read = React.useCallback(
        () => (form === undefined ? undefined : form.getSnapshot()),
        [form],
      )
      return React.useSyncExternalStore(subscribe, read, read)
    }

    /**
     * The configuration section.
     * @param props - slot props, plus the form this module resolved.
     */
    function SourceSettings(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const form = props.form
      const snapshot = useSnapshot(form)
      const [draft, setDraft] = React.useState(() => parseSources(''))
      const [draftFlags, setDraftFlags] = React.useState('')
      const [message, setMessage] = React.useState('')
      const [refused, setRefused] = React.useState(false)

      const values = snapshot === undefined ? {} : snapshot.value ?? {}
      const storedSources = parseSources(typeof values.sources === 'string' ? values.sources : '')
      const storedJson = JSON.stringify(storedSources)
      const storedFlags = typeof values.extraFlags === 'string' ? values.extraFlags : ''
      const autoAnswer = values.autoAnswer === true
      const autoAction = typeof values.autoAction === 'string' && values.autoAction === 'install' ? 'install' : 'cancel'
      const autoSourceLabel = typeof values.autoSourceLabel === 'string' ? values.autoSourceLabel : ''
      const autoUninstallAction = typeof values.autoUninstallAction === 'string' && values.autoUninstallAction === 'remove' ? 'remove' : 'keep'

      React.useEffect(() => { setDraft(JSON.parse(storedJson)) }, [storedJson])
      React.useEffect(() => { setDraftFlags(storedFlags) }, [storedFlags])

      if (snapshot === undefined) return h('p', { style: hint }, t('unavailable'))
      if (snapshot.status === 'loading') return h('p', { style: hint }, t('loading'))
      if (snapshot.status === 'unavailable') return h('p', { style: hint }, t('unavailable'))
      const readOnly = snapshot.writable !== true

      const commit = (field_, next) => {
        setRefused(false)
        setMessage('')
        if (form === undefined || typeof form.mutate !== 'function') { setRefused(true); return }
        Promise.resolve(form.mutate([{ op: 'set', path: [field_], value: next }], snapshot.revision))
          .then(accepted => { if (accepted !== true) setRefused(true) }, () => setRefused(true))
      }

      const dirty = JSON.stringify(draft) !== storedJson

      const saveSources = () => {
        const cleaned = draft.map(item => ({
          label: typeof item.label === 'string' ? item.label.trim() : '',
          url: typeof item.url === 'string' && item.url.trim().length > 0 ? item.url.trim() : null,
        }))
        if (cleaned.length === 0) { setMessage(t('emptyList')); return }
        if (cleaned.some(item => item.label.length === 0)) { setMessage(t('invalidLabel')); return }
        if (cleaned.some(item => item.url !== null && !validUrl(item.url))) { setMessage(t('invalidUrl')); return }
        setMessage(t('saved'))
        commit('sources', JSON.stringify(cleaned))
      }

      const updateRow = (index, patch) => {
        setDraft(current => current.map((item, position) => (position === index ? { ...item, ...patch } : item)))
      }

      const sourceLabels = draft
        .map(item => (typeof item.label === 'string' ? item.label.trim() : ''))
        .filter(name => name.length > 0)

      return h('div', { style: stack },

        // --- mirror list ---
        h('div', { style: field },
          h('div', { style: row },
            h('span', { style: label }, t('sourcesTitle')),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 380px', maxWidth: 520 } },
              h('div', { style: { ...hint, display: 'flex', gap: 8 } },
                h('span', { style: { width: 200 } }, t('nameColumn')),
                h('span', {}, t('urlColumn'))),
              draft.map((item, index) => h('div', { key: index, style: { display: 'flex', gap: 8, alignItems: 'center' } },
                h('input', {
                  style: { ...control, width: 200 },
                  value: typeof item.label === 'string' ? item.label : '',
                  disabled: readOnly,
                  placeholder: t('labelPlaceholder'),
                  'aria-label': t('nameColumn'),
                  onChange: event => { updateRow(index, { label: event.currentTarget.value }) },
                }),
                h('input', {
                  style: { ...control, flex: '1 1 180px', minWidth: 140 },
                  value: typeof item.url === 'string' ? item.url : '',
                  disabled: readOnly,
                  placeholder: t('urlPlaceholder'),
                  'aria-label': t('urlColumn'),
                  onChange: event => { updateRow(index, { url: event.currentTarget.value }) },
                }),
                h('button', {
                  type: 'button',
                  style: removeButton,
                  disabled: readOnly || draft.length <= 1,
                  title: t('remove'),
                  'aria-label': t('remove'),
                  onClick: () => { setDraft(current => current.filter((_, position) => position !== index)) },
                }, '×'))),
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                h('button', {
                  type: 'button',
                  style: button,
                  disabled: readOnly,
                  onClick: () => { setDraft(current => [...current, { label: '', url: null }]) },
                }, t('addSource')),
                h('button', {
                  type: 'button',
                  style: { ...button, opacity: dirty && !readOnly ? 1 : 0.5 },
                  disabled: readOnly || !dirty,
                  onClick: saveSources,
                }, t('save')),
                h('span', { style: hint }, dirty ? t('unsaved') : ''),
                message.length > 0 ? h('span', { style: hint }, message) : null))),
          h('p', { style: note }, t('sourcesHint'))),

        // --- extra pip flags ---
        h('div', { style: field },
          h('div', { style: row },
            h('label', { style: label, htmlFor: 'peg-flags' }, t('extraFlags')),
            h('input', {
              id: 'peg-flags',
              type: 'text',
              style: wide,
              value: draftFlags,
              disabled: readOnly,
              placeholder: t('extraFlagsPlaceholder'),
              onChange: event => { setDraftFlags(event.currentTarget.value) },
              onBlur: () => { if (draftFlags !== storedFlags) commit('extraFlags', draftFlags) },
              onKeyDown: event => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                if (draftFlags !== storedFlags) commit('extraFlags', draftFlags)
              },
            })),
          h('p', { style: note }, t('extraFlagsHint'))),

        // --- timeout fallback ---
        h('div', { style: field },
          h('div', { style: row },
            h('span', { style: label }, t('autoTitle')),
            h('label', { style: { ...hint, display: 'flex', alignItems: 'center', gap: 8 } },
              h('input', {
                type: 'checkbox',
                checked: autoAnswer,
                disabled: readOnly,
                onChange: event => { commit('autoAnswer', event.currentTarget.checked) },
              }),
              t('autoEnable'))),
          h('div', { style: { ...row, marginLeft: LABEL_WIDTH + GAP } },
            h('label', { style: { ...hint, width: 92 }, htmlFor: 'peg-auto-action' }, t('autoActionLabel')),
            h('select', {
              id: 'peg-auto-action',
              style: { ...control, width: 140 },
              value: autoAction,
              disabled: readOnly || !autoAnswer,
              onChange: event => { commit('autoAction', event.currentTarget.value) },
            },
            h('option', { value: 'cancel' }, t('autoCancel')),
            h('option', { value: 'install' }, t('autoInstall')))),
          h('div', { style: { ...row, marginLeft: LABEL_WIDTH + GAP } },
            h('label', { style: { ...hint, width: 92 }, htmlFor: 'peg-auto-source' }, t('autoSourceLabel')),
            h('select', {
              id: 'peg-auto-source',
              style: { ...control, width: 200 },
              value: sourceLabels.includes(autoSourceLabel) ? autoSourceLabel : '',
              disabled: readOnly || !autoAnswer || autoAction !== 'install',
              onChange: event => { commit('autoSourceLabel', event.currentTarget.value) },
            },
            h('option', { value: '' }, t('autoSourceMissing')),
            sourceLabels.map(name => h('option', { key: name, value: name }, name)))),
          h('div', { style: { ...row, marginLeft: LABEL_WIDTH + GAP } },
            h('label', { style: { ...hint, width: 92 }, htmlFor: 'peg-auto-uninstall' }, t('autoUninstallLabel')),
            h('select', {
              id: 'peg-auto-uninstall',
              style: { ...control, width: 200 },
              value: autoUninstallAction,
              disabled: readOnly || !autoAnswer,
              onChange: event => { commit('autoUninstallAction', event.currentTarget.value) },
            },
            h('option', { value: 'keep' }, t('autoUninstallKeep')),
            h('option', { value: 'remove' }, t('autoUninstallRemove')))),
          h('p', { style: note }, t('autoHint'))),

        readOnly ? h('p', { style: note }, t('readOnly')) : null,
        refused ? h('p', { style: { ...errorText, marginLeft: LABEL_WIDTH + GAP } }, t('refused')) : null)
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }))

        let form
        ctx.inject(['configForms'], (child) => {
          try {
            form = child.configForms.get(ENTRY_ID)
          } catch {
            form = undefined
          }
          child.effect(() => child.slots.inject('conversation.input.dock', () => child.slots.register({
            name: 'conversation.input.dock',
            id: 'python-env-guard-notice',
            order: 10,
            locale: NS,
          }, props => h(NoticeStrip, { ...props, form }))))
        })

        ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: BUNDLE,
          locale: NS,
        }, props => h(SourceSettings, { ...props, form }))))
      },
    }
  },
})
