import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from 'react';
import { createPortal } from 'react-dom';
import {
  FileText,
  FileType2,
  Check,
  Lightbulb,
  PanelsTopLeft,
  Paperclip,
  Plus,
  Presentation,
  Shapes,
  Table2,
  Target
} from 'lucide-react';

interface AddMenuItem {
  id: string;
  label: string;
  description?: string;
  icon: ReactNode;
  tone?: 'documents' | 'pdf' | 'spreadsheets' | 'presentations' | 'templates' | 'sites';
  highlighted?: boolean;
  active?: boolean;
  disabled?: boolean;
}

interface AddMenuLayout {
  left: number;
  bottom: number;
  width: number;
  maxHeight: number;
}

const addItems: readonly AddMenuItem[] = [
  { id: 'files', label: '文件和文件夹', icon: <Paperclip size={18} />, highlighted: true },
  { id: 'goal', label: '目标', description: '设置要持续追求的目标', icon: <Target size={18} /> },
  { id: 'plan', label: '计划模式', description: '开启计划模式', icon: <Lightbulb size={18} /> }
];

const pluginItems: readonly AddMenuItem[] = [
  { id: 'documents', label: 'Documents', description: 'Create and edit document artifacts', icon: <FileText size={17} />, tone: 'documents' },
  { id: 'pdf', label: 'PDF', description: 'Read, create, and verify PDF files', icon: <FileType2 size={17} />, tone: 'pdf' },
  { id: 'spreadsheets', label: 'Spreadsheets', description: 'Create and edit spreadsheet files', icon: <Table2 size={17} />, tone: 'spreadsheets' },
  { id: 'presentations', label: 'Presentations', description: 'Create and edit presentations', icon: <Presentation size={17} />, tone: 'presentations' },
  { id: 'template-creator', label: 'Template Creator', description: 'Create or update reusable templates from reference content', icon: <Shapes size={17} />, tone: 'templates' },
  { id: 'sites', label: 'Sites', description: 'Build and deploy websites with Sites', icon: <PanelsTopLeft size={17} />, tone: 'sites' }
];

export function ComposerAddMenu({
  planModeAvailable,
  planModeEnabled,
  onPlanModeChange
}: {
  planModeAvailable: boolean;
  planModeEnabled: boolean;
  onPlanModeChange(enabled: boolean): void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [layout, setLayout] = useState<AddMenuLayout | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const updateLayout = useCallback((): void => {
    const composer = rootRef.current?.closest<HTMLElement>('.composer');
    if (!composer) return;
    const bounds = composer.getBoundingClientRect();
    setLayout({
      left: bounds.left,
      bottom: Math.max(10, window.innerHeight - bounds.top + 8),
      width: bounds.width,
      maxHeight: Math.max(160, Math.min(410, bounds.top - 20))
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setLayout(null);
      return;
    }
    updateLayout();
    let frame: number | null = null;
    const scheduleUpdate = (): void => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        updateLayout();
      });
    };
    const observer = new ResizeObserver(scheduleUpdate);
    const composer = rootRef.current?.closest<HTMLElement>('.composer');
    if (composer) observer.observe(composer);
    window.addEventListener('resize', scheduleUpdate);
    document.addEventListener('scroll', scheduleUpdate, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', scheduleUpdate);
      document.removeEventListener('scroll', scheduleUpdate, true);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [open, updateLayout]);

  useEffect(() => {
    if (!open) return;
    const closeWhenOutside = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    };
    document.addEventListener('pointerdown', closeWhenOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeWhenOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const popoverStyle: CSSProperties | undefined = layout
    ? {
        left: layout.left,
        bottom: layout.bottom,
        width: layout.width,
        maxHeight: layout.maxHeight
      }
    : undefined;

  const popover = open
    ? (
        <div
          ref={popoverRef}
          className="composer-add-popover"
          style={popoverStyle}
          role="menu"
          aria-label="添加"
          data-layout-ready={layout ? 'true' : 'false'}
        >
          <ComposerAddMenuSection
            title="添加"
            items={addItems.map((item) => item.id === 'plan'
              ? {
                  ...item,
                  active: planModeEnabled,
                  disabled: !planModeAvailable,
                  ...(!planModeAvailable
                    ? { description: '当前 Runtime 版本不支持计划模式，请完整重启 Ariadne' }
                    : {})
                }
              : item)}
            onSelect={(item) => {
              if (item.id !== 'plan' || item.disabled) return;
              onPlanModeChange(!planModeEnabled);
              setOpen(false);
              window.requestAnimationFrame(() => triggerRef.current?.focus());
            }}
          />
          <ComposerAddMenuSection title="插件" items={pluginItems} />
        </div>
      )
    : null;

  return (
    <div className="composer-add-control" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`composer-add-trigger${open ? ' is-open' : ''}`}
        aria-label="添加"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Plus size={18} strokeWidth={1.8} />
      </button>
      {planModeEnabled && (
        <button
          type="button"
          className="composer-plan-mode-chip"
          aria-label="关闭计划模式"
          onClick={() => onPlanModeChange(false)}
        >
          <Lightbulb size={14} />
          <span>计划模式</span>
        </button>
      )}
      {popover ? createPortal(popover, document.body) : null}
    </div>
  );
}

function ComposerAddMenuSection({
  title,
  items,
  onSelect
}: {
  title: string;
  items: readonly AddMenuItem[];
  onSelect?(item: AddMenuItem): void;
}): React.JSX.Element {
  return (
    <section className="composer-add-section" aria-label={title}>
      <h3>{title}</h3>
      <div className="composer-add-items">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className={`composer-add-item${item.highlighted ? ' is-highlighted' : ''}${item.active ? ' is-active' : ''}`}
            disabled={item.disabled}
            aria-label={item.id === 'plan' ? item.label : `${item.label}（功能展示）`}
            {...(item.id === 'plan'
              ? {
                  'aria-pressed': item.active === true,
                  onClick: () => onSelect?.(item)
                }
              : {})}
          >
            <span className={`composer-add-item-icon${item.tone ? ` is-${item.tone}` : ''}`} aria-hidden="true">
              {item.icon}
            </span>
            <span className="composer-add-item-copy">
              <strong>{item.label}</strong>
              {item.description && <small>{item.description}</small>}
            </span>
            {item.active && <Check className="composer-add-item-check" size={16} aria-hidden="true" />}
          </button>
        ))}
      </div>
    </section>
  );
}
