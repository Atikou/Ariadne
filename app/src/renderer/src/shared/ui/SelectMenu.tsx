import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import {
  calculateSelectMenuLayout,
  calculateSelectSubmenuLayout,
  type SelectMenuLayout,
  type SelectMenuPlacement,
  type SelectSubmenuLayout
} from '@shared/select-menu-layout';

export interface SelectMenuOption<T extends string> {
  value: T;
  label: string;
  description?: string;
  icon?: ReactNode;
  tone?: 'default' | 'warning';
  children?: readonly SelectMenuOption<T>[];
}

interface SelectMenuProps<T extends string> {
  value: T;
  options: readonly SelectMenuOption<T>[];
  onChange(value: T): void;
  ariaLabel: string;
  className?: string;
  popoverClassName?: string;
  triggerLabel?: ReactNode;
  leadingIcon?: ReactNode;
  placement?: SelectMenuPlacement;
  disabled?: boolean;
}

const DEFAULT_MENU_WIDTH = 170;
const DEFAULT_SUBMENU_WIDTH = 180;

export function SelectMenu<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
  popoverClassName,
  triggerLabel,
  leadingIcon,
  placement = 'bottom',
  disabled = false
}: SelectMenuProps<T>): React.JSX.Element {
  const selectedTopIndex = findSelectedTopIndex(options, value);
  const selectedIndex = selectedTopIndex < 0 ? 0 : selectedTopIndex;
  const selectedOption = options[selectedIndex];
  const [open, setOpen] = useState(false);
  const [ownerDocument, setOwnerDocument] = useState<Document>(() => document);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const [openSubmenuIndex, setOpenSubmenuIndex] = useState<number | null>(null);
  const [activeSubmenuIndex, setActiveSubmenuIndex] = useState(0);
  const [popoverLayout, setPopoverLayout] = useState<SelectMenuLayout | null>(null);
  const [submenuLayout, setSubmenuLayout] = useState<SelectSubmenuLayout | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const submenuOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const focusSubmenuRef = useRef(false);
  const restoreFocusRef = useRef(false);
  const listboxId = useId();
  const submenuId = useId();
  const openSubmenu = openSubmenuIndex === null ? null : options[openSubmenuIndex];
  const submenuOptions = openSubmenu?.children ?? [];

  const updatePopoverLayout = useCallback((): void => {
    const root = rootRef.current;
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!root || !trigger || !popover) return;
    const view = root.ownerDocument.defaultView;
    if (!view) return;
    const anchor = trigger.getBoundingClientRect();
    const configuredWidth = readCssLength(root, '--select-menu-min-width');
    const next = calculateSelectMenuLayout({
      anchor,
      naturalHeight: popover.scrollHeight,
      preferredPlacement: placement,
      minimumWidth: configuredWidth ?? DEFAULT_MENU_WIDTH,
      viewportWidth: view.innerWidth,
      viewportHeight: view.innerHeight
    });
    setPopoverLayout((current) => layoutsEqual(current, next) ? current : next);
  }, [placement]);

  const updateSubmenuLayout = useCallback((): void => {
    if (openSubmenuIndex === null) return;
    const root = rootRef.current;
    const anchorElement = optionRefs.current[openSubmenuIndex];
    const submenu = submenuRef.current;
    if (!root || !anchorElement || !submenu) return;
    const view = root.ownerDocument.defaultView;
    if (!view) return;
    const configuredWidth = readCssLength(root, '--select-submenu-min-width');
    const next = calculateSelectSubmenuLayout({
      anchor: anchorElement.getBoundingClientRect(),
      naturalHeight: submenu.scrollHeight,
      minimumWidth: configuredWidth ?? DEFAULT_SUBMENU_WIDTH,
      viewportWidth: view.innerWidth,
      viewportHeight: view.innerHeight
    });
    setSubmenuLayout((current) => submenuLayoutsEqual(current, next) ? current : next);
  }, [openSubmenuIndex]);

  useEffect(() => {
    if (!open) return;
    const closeWhenOutside = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)
        || popoverRef.current?.contains(target)
        || submenuRef.current?.contains(target)) return;
      setOpen(false);
      setOpenSubmenuIndex(null);
    };
    ownerDocument.addEventListener('pointerdown', closeWhenOutside);
    return () => ownerDocument.removeEventListener('pointerdown', closeWhenOutside);
  }, [open, ownerDocument]);

  useLayoutEffect(() => {
    if (!open) {
      setPopoverLayout(null);
      setSubmenuLayout(null);
      if (restoreFocusRef.current) {
        restoreFocusRef.current = false;
        triggerRef.current?.focus({ preventScroll: true });
      }
      return;
    }
    const view = ownerDocument.defaultView;
    if (!view) return;
    let frame: number | null = null;
    const scheduleUpdate = (): void => {
      if (frame !== null) return;
      frame = view.requestAnimationFrame(() => {
        frame = null;
        updatePopoverLayout();
        updateSubmenuLayout();
      });
    };
    updatePopoverLayout();
    updateSubmenuLayout();
    const observer = new view.ResizeObserver(scheduleUpdate);
    if (triggerRef.current) observer.observe(triggerRef.current);
    if (popoverRef.current) observer.observe(popoverRef.current);
    if (submenuRef.current) observer.observe(submenuRef.current);
    view.addEventListener('resize', scheduleUpdate);
    ownerDocument.addEventListener('scroll', scheduleUpdate, true);
    return () => {
      observer.disconnect();
      view.removeEventListener('resize', scheduleUpdate);
      ownerDocument.removeEventListener('scroll', scheduleUpdate, true);
      if (frame !== null) view.cancelAnimationFrame(frame);
    };
  }, [open, openSubmenuIndex, options.length, ownerDocument, updatePopoverLayout, updateSubmenuLayout]);

  useEffect(() => {
    if (open && popoverLayout && openSubmenuIndex === null) focusMenuOption(optionRefs.current[activeIndex]);
  }, [activeIndex, open, openSubmenuIndex, popoverLayout]);

  useEffect(() => {
    if (open && submenuLayout && openSubmenuIndex !== null && focusSubmenuRef.current) {
      focusSubmenuRef.current = false;
      focusMenuOption(submenuOptionRefs.current[activeSubmenuIndex]);
    }
  }, [activeSubmenuIndex, open, openSubmenuIndex, submenuLayout]);

  const showSubmenu = (index: number, moveFocus = false): void => {
    const children = options[index]?.children;
    if (!children?.length) return;
    const selectedChildIndex = Math.max(0, children.findIndex((option) => option.value === value));
    setActiveIndex(index);
    setActiveSubmenuIndex(selectedChildIndex);
    focusSubmenuRef.current = moveFocus;
    setSubmenuLayout(null);
    setOpenSubmenuIndex(index);
  };

  const openMenu = (index = selectedIndex): void => {
    if (options.length === 0) return;
    setOwnerDocument(rootRef.current?.ownerDocument ?? document);
    setActiveIndex(index);
    setOpenSubmenuIndex(null);
    setPopoverLayout(null);
    setOpen(true);
  };

  const closeMenu = (restoreFocus = false): void => {
    restoreFocusRef.current = restoreFocus;
    setOpen(false);
    setOpenSubmenuIndex(null);
  };

  const moveActive = (offset: number): void => {
    if (options.length === 0) return;
    setOpenSubmenuIndex(null);
    setActiveIndex((current) => (current + offset + options.length) % options.length);
  };

  const selectOption = (option: SelectMenuOption<T>): void => {
    onChange(option.value);
    closeMenu(true);
  };

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) open ? closeMenu() : openMenu();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    event.stopPropagation();
    openMenu(event.key === 'ArrowDown' ? selectedIndex : (selectedIndex - 1 + options.length) % options.length);
  };

  const handleOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (['Escape', 'Tab', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (event.key === 'Tab') {
      triggerRef.current?.focus({ preventScroll: true });
      closeMenu();
      return;
    }
    if (event.key === 'ArrowRight' && options[index]?.children?.length) {
      event.preventDefault();
      showSubmenu(index, true);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setOpenSubmenuIndex(null);
      setActiveIndex(event.key === 'Home' ? 0 : options.length - 1);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const option = options[index];
      if (!option) return;
      if (option.children?.length) showSubmenu(index, true);
      else selectOption(option);
    }
  };

  const handleSubmenuKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (['Escape', 'Tab', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (event.key === 'Tab') {
      triggerRef.current?.focus({ preventScroll: true });
      closeMenu();
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      const parentIndex = openSubmenuIndex;
      setOpenSubmenuIndex(null);
      if (parentIndex !== null) ownerDocument.defaultView?.requestAnimationFrame(() => focusMenuOption(optionRefs.current[parentIndex]));
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusSubmenuRef.current = true;
      setActiveSubmenuIndex((current) => (
        current + (event.key === 'ArrowDown' ? 1 : -1) + submenuOptions.length
      ) % submenuOptions.length);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      focusSubmenuRef.current = true;
      setActiveSubmenuIndex(event.key === 'Home' ? 0 : submenuOptions.length - 1);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const option = submenuOptions[index];
      if (option) selectOption(option);
    }
  };

  const rootClassName = ['select-menu', `select-menu--${placement}`, className].filter(Boolean).join(' ');
  const popover = open ? (
    <div
      ref={popoverRef}
      id={listboxId}
      className={['select-menu-popover', popoverClassName].filter(Boolean).join(' ')}
      role="listbox"
      aria-label={ariaLabel}
      data-placement={popoverLayout?.placement}
      style={{
        top: popoverLayout?.top ?? 0,
        left: popoverLayout?.left ?? 0,
        width: popoverLayout?.width ?? DEFAULT_MENU_WIDTH,
        maxHeight: popoverLayout?.maxHeight,
        visibility: popoverLayout ? 'visible' : 'hidden'
      }}
    >
      {options.map((option, index) => {
        const selected = option.value === value || option.children?.some((child) => child.value === value) === true;
        const hasSubmenu = Boolean(option.children?.length);
        return (
          <button
            key={option.value}
            ref={(element) => { optionRefs.current[index] = element; }}
            type="button"
            role="option"
            aria-selected={selected}
            aria-haspopup={hasSubmenu ? 'listbox' : undefined}
            aria-expanded={hasSubmenu ? openSubmenuIndex === index : undefined}
            aria-controls={hasSubmenu && openSubmenuIndex === index ? submenuId : undefined}
            className={`select-menu-option${selected ? ' is-selected' : ''}${option.icon ? ' has-icon' : ''}${option.tone === 'warning' ? ' is-warning' : ''}${hasSubmenu ? ' is-has-submenu' : ''}`}
            onMouseEnter={() => {
              setActiveIndex(index);
              if (hasSubmenu) showSubmenu(index);
              else setOpenSubmenuIndex(null);
            }}
            onKeyDown={(event) => handleOptionKeyDown(event, index)}
            onClick={() => {
              if (hasSubmenu) showSubmenu(index, true);
              else selectOption(option);
            }}
          >
            {option.icon && <span className="select-menu-option-icon">{option.icon}</span>}
            <span className="select-menu-option-copy">
              <strong>{option.label}</strong>
              {option.description && <small>{option.description}</small>}
            </span>
            <span className="select-menu-option-trailing">
              {selected && <Check className="select-menu-check" size={15} />}
              {hasSubmenu && <ChevronRight className="select-menu-chevron" size={14} />}
            </span>
          </button>
        );
      })}
    </div>
  ) : null;

  const submenu = open && openSubmenuIndex !== null && submenuOptions.length > 0 ? (
    <div
      ref={submenuRef}
      id={submenuId}
      className="select-menu-submenu"
      role="listbox"
      aria-label={`${openSubmenu?.label ?? ariaLabel} - 子菜单`}
      data-direction={submenuLayout?.direction}
      style={{
        top: submenuLayout?.top ?? 0,
        left: submenuLayout?.left ?? 0,
        width: submenuLayout?.width ?? DEFAULT_SUBMENU_WIDTH,
        maxHeight: submenuLayout?.maxHeight,
        visibility: submenuLayout ? 'visible' : 'hidden'
      }}
    >
      {submenuOptions.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(element) => { submenuOptionRefs.current[index] = element; }}
            type="button"
            role="option"
            aria-selected={selected}
            className={`select-menu-option${selected ? ' is-selected' : ''}${option.icon ? ' has-icon' : ''}${option.tone === 'warning' ? ' is-warning' : ''}`}
            onMouseEnter={() => setActiveSubmenuIndex(index)}
            onKeyDown={(event) => handleSubmenuKeyDown(event, index)}
            onClick={() => selectOption(option)}
          >
            {option.icon && <span className="select-menu-option-icon">{option.icon}</span>}
            <span className="select-menu-option-copy">
              <strong>{option.label}</strong>
              {option.description && <small>{option.description}</small>}
            </span>
            <span className="select-menu-option-trailing">{selected && <Check className="select-menu-check" size={15} />}</span>
          </button>
        );
      })}
    </div>
  ) : null;

  return (
    <div className={rootClassName} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="select-menu-trigger"
        aria-label={ariaLabel}
        title={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        disabled={disabled || options.length === 0}
        data-tone={selectedOption?.tone ?? 'default'}
        onClick={() => open ? closeMenu() : openMenu()}
        onKeyDown={handleTriggerKeyDown}
      >
        {leadingIcon ?? selectedOption?.icon}
        <span className="select-menu-value">{triggerLabel ?? selectedOption?.label ?? value}</span>
        <ChevronDown className={open ? 'is-open' : ''} size={13} />
      </button>
      {(popover || submenu) && createPortal(<>{popover}{submenu}</>, rootRef.current?.closest('dialog') ?? ownerDocument.body)}
    </div>
  );
}

function findSelectedTopIndex<T extends string>(options: readonly SelectMenuOption<T>[], value: T): number {
  return options.findIndex((option) => option.value === value
    || option.children?.some((child) => child.value === value) === true);
}

function readCssLength(element: HTMLElement, property: string): number | null {
  const value = Number.parseFloat(element.ownerDocument.defaultView?.getComputedStyle(element).getPropertyValue(property) ?? '');
  return Number.isFinite(value) ? value : null;
}

function focusMenuOption(option: HTMLButtonElement | null | undefined): void {
  if (!option) return;
  option.focus({ preventScroll: true });
  const menu = option.closest<HTMLElement>('[role="listbox"]');
  if (!menu) return;
  const bounds = menu.getBoundingClientRect();
  const item = option.getBoundingClientRect();
  if (item.top < bounds.top) menu.scrollTop += item.top - bounds.top;
  else if (item.bottom > bounds.bottom) menu.scrollTop += item.bottom - bounds.bottom;
}

function layoutsEqual(left: SelectMenuLayout | null, right: SelectMenuLayout): boolean {
  return left?.top === right.top
    && left.left === right.left
    && left.width === right.width
    && left.maxHeight === right.maxHeight
    && left.placement === right.placement;
}

function submenuLayoutsEqual(left: SelectSubmenuLayout | null, right: SelectSubmenuLayout): boolean {
  return left?.top === right.top
    && left.left === right.left
    && left.width === right.width
    && left.maxHeight === right.maxHeight
    && left.direction === right.direction;
}
