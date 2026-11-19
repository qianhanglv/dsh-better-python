/**
 * Browser half of dsh-better-python.
 *
 * Adds an inline settings section to the bundle's page in the Plugins view:
 * the default install source and the extra pip flags the user allows. Both are
 * volatile Host config fields, so saving updates the running plugin in place.
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

    /** Mirrors the Host SOURCES table. */
    const SOURCE_IDS = ['default', 'tuna', 'aliyun', 'ustc', 'tencent', 'douban', 'custom']

    const zh = {
      title: '默认安装源',
      hint: 'python_install 弹窗里预先选中的源；同一次确认里仍可临时切换或填写自定义镜像。',
      customUrl: '自定义 index URL',
      customUrlHint: '支持 http/https，例如 https://mirror.example.com/simple/',
      loading: '正在读取当前设置…',
      unavailable: '无法读取该插件的配置：可能是设置服务未就绪，或当前配置文件不可写。',
      readOnly: '当前配置文件为只读，无法保存。',
      refused: 'Host 没有接受这个值。',
      'source.default': '默认源（PyPI）',
      'source.tuna': '清华 TUNA',
      'source.aliyun': '阿里云',
      'source.ustc': '中科大 USTC',
      'source.tencent': '腾讯云',
      'source.douban': '豆瓣',
      'source.custom': '自定义镜像',
      extraFlags: '额外的 pip 参数',
      extraFlagsPlaceholder: '例如：--only-binary=:all:',
      extraFlagsHint: '空格分隔，例如 --only-binary=:all: --config-settings=--build-option=1。改安装源或安装目标的参数（-i、--index-url、--find-links、--target、--user、--break-system-packages 等）永远不允许，填了也不生效。',
    }

    const en = {
      title: 'Default install source',
      hint: 'Preselected in the python_install dialog; that dialog can still switch source or take a custom mirror for one install.',
      customUrl: 'Custom index URL',
      customUrlHint: 'http or https, for example https://mirror.example.com/simple/',
      loading: 'Reading the current value…',
      unavailable: 'Cannot read this plugin configuration: the settings service is unavailable or the profile is read-only.',
      readOnly: 'This profile stores settings read-only.',
      refused: 'The Host did not accept that value.',
      'source.default': 'Default (PyPI)',
      'source.tuna': 'Tsinghua TUNA',
      'source.aliyun': 'Aliyun',
      'source.ustc': 'USTC',
      'source.tencent': 'Tencent Cloud',
      'source.douban': 'Douban',
      'source.custom': 'Custom mirror',
      extraFlags: 'Extra pip flags',
      extraFlagsPlaceholder: 'e.g. --only-binary=:all:',
      extraFlagsHint: 'Space-separated, for example --only-binary=:all: --config-settings=--build-option=1. Flags that change the install source or target (-i, --index-url, --find-links, --target, --user, --break-system-packages) are never allowed and are ignored.',
    }

    const LABEL_WIDTH = 118
    const GAP = 12
    const stack = { display: 'flex', flexDirection: 'column', gap: 14, padding: '12px 0' }
    const field = { display: 'flex', flexDirection: 'column', gap: 4 }
    const row = { display: 'flex', alignItems: 'center', gap: GAP }
    const label = { color: 'var(--dsw-alias-label-primary)', fontSize: 13, width: LABEL_WIDTH, flex: `0 0 ${LABEL_WIDTH}px` }
    const hint = { color: 'var(--dsw-alias-label-caption)', fontSize: 12, margin: 0, marginLeft: LABEL_WIDTH + GAP }
    const control = {
      font: 'inherit',
      color: 'var(--dsw-alias-label-primary)',
      background: 'var(--dsw-alias-bg-layer-1)',
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: 6,
      padding: '4px 8px',
      width: 380,
      maxWidth: '100%',
      boxSizing: 'border-box',
    }
    const refusedText = { ...hint, color: 'var(--dsw-alias-state-error-primary)' }

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
     * The settings section: default source, optional custom mirror, extra flags.
     * @param props - slot props, plus the form this module resolved.
     */
    function SourceSettings(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const form = props.form
      const snapshot = useSnapshot(form)
      const [draftUrl, setDraftUrl] = React.useState('')
      const [draftFlags, setDraftFlags] = React.useState('')
      const [refused, setRefused] = React.useState(false)

      const values = snapshot === undefined ? {} : snapshot.value ?? {}
      const sourceId = typeof values.sourceId === 'string' && values.sourceId !== '' ? values.sourceId : 'default'
      const storedUrl = typeof values.customUrl === 'string' ? values.customUrl : ''
      const storedFlags = typeof values.extraFlags === 'string' ? values.extraFlags : ''

      React.useEffect(() => { setDraftUrl(storedUrl) }, [storedUrl])
      React.useEffect(() => { setDraftFlags(storedFlags) }, [storedFlags])

      if (snapshot === undefined) return h('p', { style: hint }, t('unavailable'))
      if (snapshot.status === 'loading') return h('p', { style: hint }, t('loading'))
      if (snapshot.status === 'unavailable') return h('p', { style: hint }, t('unavailable'))
      const readOnly = snapshot.writable !== true

      const commit = (field, next) => {
        setRefused(false)
        if (form === undefined || typeof form.mutate !== 'function') { setRefused(true); return }
        Promise.resolve(form.mutate([{ op: 'set', path: [field], value: next }], snapshot.revision))
          .then(accepted => { if (accepted !== true) setRefused(true) }, () => setRefused(true))
      }

      return h('div', { style: stack },
        h('div', { style: field },
          h('div', { style: row },
            h('label', { style: label, htmlFor: 'peg-source' }, t('title')),
            h('select', {
              id: 'peg-source',
              style: control,
              value: sourceId,
              disabled: readOnly,
              onChange: event => { commit('sourceId', event.currentTarget.value) },
            }, SOURCE_IDS.map(id => h('option', { key: id, value: id }, t(`source.${id}`))))),
          h('p', { style: hint }, t('hint'))),
        sourceId === 'custom'
          ? h('div', { style: field },
            h('div', { style: row },
              h('label', { style: label, htmlFor: 'peg-url' }, t('customUrl')),
              h('input', {
                id: 'peg-url',
                type: 'url',
                style: control,
                value: draftUrl,
                disabled: readOnly,
                placeholder: 'https://mirror.example.com/simple/',
                onChange: event => { setDraftUrl(event.currentTarget.value) },
                onBlur: () => { if (draftUrl !== storedUrl) commit('customUrl', draftUrl) },
                onKeyDown: event => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  if (draftUrl !== storedUrl) commit('customUrl', draftUrl)
                },
              })),
            h('p', { style: hint }, t('customUrlHint')))
          : null,
        h('div', { style: field },
          h('div', { style: row },
            h('label', { style: label, htmlFor: 'peg-flags' }, t('extraFlags')),
            h('input', {
              id: 'peg-flags',
              type: 'text',
              style: control,
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
          h('p', { style: hint }, t('extraFlagsHint'))),
        readOnly ? h('p', { style: hint }, t('readOnly')) : null,
        refused ? h('p', { style: refusedText }, t('refused')) : null)
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }))

        // Resolved once the settings service exists; the section renders a
        // message instead of vanishing when it is absent, so a broken wiring is
        // visible rather than silent.
        let form
        ctx.inject(['configForms'], (child) => {
          try {
            form = child.configForms.get(ENTRY_ID)
          } catch {
            form = undefined
          }
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
