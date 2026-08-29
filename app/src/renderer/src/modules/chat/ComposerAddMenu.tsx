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
  Check,
  ImagePlus,
  Lightbulb,
  Plus,
} from 'lucide-react';

interface AddMenuItem {
  id: string;
  label: string;
  description?: string;
  icon: ReactNode;
  active?: boolean;
  disabled?: boolean;
}

interface AddMenuLayout {
  left: number;
  bottom: number;
  width: number;
  maxHeight: number;
}

export function ComposerAddMenu({
  planModeAvailable,
  planModeEnabled,
  planModeDisabledReason,
  imageAttachmentsAvailable,
  imageAttachmentsDisabledReason,
  onPlanModeChange,
  onAddImages
}: {
  planModeAvailable: boolean;
  planModeEnabled: boolean;
  planModeDisabledReason?: string;
  imageAttachmentsAvailable: boolean;
  imageAttachmentsDisabledReason?: string;
  onPlanModeChange(enabled: boolean): void;
  onAddImages(): void;
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
            items={[
              {
                id: 'image',
                label: '添加图片',
                description: imageAttachmentsAvailable
                  ? 'PNG、JPEG 或 WebP，合计不超过 2 MB'
                  : imageAttachmentsDisabledReason ?? '当前没有可用的视觉模型',
                icon: <ImagePlus size={18} />,
                disabled: !imageAttachmentsAvailable
              },
              {
                id: 'plan',
                label: '计划模式',
                description: planModeAvailable
                  ? '开启计划模式'
                  : planModeDisabledReason ?? '当前 Runtime 版本不支持计划模式，请完整重启 Ariadne',
                icon: <Lightbulb size={18} />,
                active: planModeEnabled,
                disabled: !planModeAvailable
              }
            ]}
            onSelect={(item) => {
              if (item.disabled) return;
              if (item.id === 'image') onAddImages();
              else if (item.id === 'plan') onPlanModeChange(!planModeEnabled);
              else return;
              setOpen(false);
              window.requestAnimationFrame(() => triggerRef.current?.focus());
            }}
          />
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
            className={`composer-add-item${item.active ? ' is-active' : ''}`}
            disabled={item.disabled}
            aria-label={item.label}
            aria-pressed={item.active === true}
            onClick={() => onSelect?.(item)}
          >
            <span className="composer-add-item-icon" aria-hidden="true">
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
