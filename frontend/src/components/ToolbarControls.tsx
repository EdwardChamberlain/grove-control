import { Children, isValidElement, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';

export type ToolbarDropdownOption<T extends string> = {
  value: T;
  label: string;
};

type ReactSelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
  group?: string;
};

type ReactSelectChangeEvent = {
  target: { value: string; name?: string };
  currentTarget: { value: string; name?: string };
};

export const toolbarControlClass =
  'h-8 px-2 rounded-lg border bg-bambu-dark border-bambu-dark-tertiary text-white text-sm font-medium transition-colors hover:bg-bambu-dark-tertiary focus:outline-none focus:border-bambu-green';

export const toolbarIconButtonClass =
  'h-8 w-8 rounded-lg border bg-bambu-dark border-bambu-dark-tertiary text-white hover:bg-bambu-dark-tertiary transition-colors flex items-center justify-center';

function getNodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(getNodeText).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return getNodeText(node.props.children);
  return '';
}

function optionValueFromElement(element: ReactElement<{ value?: string | number; children?: ReactNode }>) {
  return element.props.value === undefined ? getNodeText(element.props.children) : String(element.props.value);
}

function parseSelectOptions(children: ReactNode): ReactSelectOption[] {
  const options: ReactSelectOption[] = [];

  Children.forEach(children, child => {
    if (!isValidElement(child)) return;

    if (child.type === 'option') {
      const option = child as ReactElement<{ value?: string | number; disabled?: boolean; children?: ReactNode }>;
      options.push({
        value: optionValueFromElement(option),
        label: getNodeText(option.props.children),
        disabled: option.props.disabled,
      });
      return;
    }

    if (child.type === 'optgroup') {
      const group = child as ReactElement<{ label?: string; children?: ReactNode }>;
      Children.forEach(group.props.children, groupChild => {
        if (!isValidElement(groupChild) || groupChild.type !== 'option') return;
        const option = groupChild as ReactElement<{ value?: string | number; disabled?: boolean; children?: ReactNode }>;
        options.push({
          value: optionValueFromElement(option),
          label: getNodeText(option.props.children),
          disabled: option.props.disabled,
          group: group.props.label,
        });
      });
    }
  });

  return options;
}

export function ToolbarDropdown<T extends string>({
  value,
  options,
  onChange,
  fullWidth = false,
  minWidthClass = 'min-w-28',
  selectedLabel,
  disabled = false,
}: {
  value: T;
  options: ToolbarDropdownOption<T>[];
  onChange: (value: T) => void;
  fullWidth?: boolean;
  minWidthClass?: string;
  selectedLabel?: string;
  disabled?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0, minWidth: 0 });
  const selectedOption = options.find(option => option.value === value) ?? options[0];

  useEffect(() => {
    if (!isOpen) return;

    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setMenuPosition({
        left: rect.left,
        top: rect.bottom + 4,
        minWidth: rect.width,
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);

    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [isOpen]);

  return (
    <div className={`relative ${fullWidth ? 'w-full min-w-0' : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen(open => !open)}
        className={`${toolbarControlClass} flex items-center justify-between gap-2 ${fullWidth ? 'w-full' : minWidthClass} ${disabled ? 'opacity-60 cursor-not-allowed hover:bg-bambu-dark' : ''}`}
      >
        <span className="truncate">{selectedLabel ?? selectedOption?.label}</span>
        <ChevronDown className={`w-4 h-4 text-bambu-gray transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        createPortal(
          <>
          <div className="fixed inset-0 z-10" onClick={() => setIsOpen(false)} />
          <div
            className="fixed z-50 max-h-72 overflow-y-auto rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary py-1 shadow-xl"
            style={{
              left: menuPosition.left,
              top: menuPosition.top,
              minWidth: menuPosition.minWidth,
            }}
          >
            {options.map(option => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onChange(option.value);
                  setIsOpen(false);
                }}
                className={`w-full px-3 py-2 text-left text-sm transition-colors hover:bg-bambu-dark-tertiary ${
                  option.value === value ? 'text-bambu-green' : 'text-white'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          </>,
          document.body
        )
      )}
    </div>
  );
}

export function ReactSelect({
  value,
  defaultValue,
  onChange,
  children,
  className = '',
  disabled = false,
  required = false,
  name,
  id,
  title,
  'aria-label': ariaLabel,
}: {
  value?: string | number | readonly string[];
  defaultValue?: string | number | readonly string[];
  onChange?: (event: ReactSelectChangeEvent) => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  id?: string;
  title?: string;
  'aria-label'?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const reactId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const hiddenSelectRef = useRef<HTMLSelectElement | null>(null);
  const typeaheadRef = useRef('');
  const typeaheadTimeoutRef = useRef<number | null>(null);
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0, minWidth: 0 });
  const [labelId, setLabelId] = useState<string | undefined>();
  const options = useMemo(() => parseSelectOptions(children), [children]);
  const controlledValue = Array.isArray(value)
    ? String(value[0] ?? '')
    : value !== undefined
      ? String(value)
      : undefined;
  const initialValueRef = useRef(
    Array.isArray(defaultValue)
      ? String(defaultValue[0] ?? '')
      : defaultValue !== undefined
        ? String(defaultValue)
        : options[0]?.value ?? '',
  );
  const [internalValue, setInternalValue] = useState(initialValueRef.current);
  const currentValue = controlledValue ?? internalValue;
  const selectedOption = options.find(option => option.value === currentValue) ?? options[0];
  const selectedIndex = Math.max(0, options.findIndex(option => option.value === currentValue));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const listboxId = `${reactId}-listbox`;
  const selectedValueId = `${reactId}-value`;

  const getOptionId = (index: number) => `${reactId}-option-${index}`;

  const findNextEnabledIndex = (startIndex: number, direction: 1 | -1) => {
    if (options.length === 0) return -1;

    for (let offset = 0; offset < options.length; offset += 1) {
      const index = (startIndex + offset * direction + options.length) % options.length;
      if (!options[index].disabled) return index;
    }

    return -1;
  };

  const openMenu = (nextActiveIndex = selectedIndex) => {
    const enabledIndex = options[nextActiveIndex]?.disabled
      ? findNextEnabledIndex(nextActiveIndex, 1)
      : nextActiveIndex;
    if (enabledIndex >= 0) setActiveIndex(enabledIndex);
    setIsOpen(true);
  };

  useEffect(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const optionElements = options.map(option => {
      const element = document.createElement('option');
      element.value = option.value;
      element.textContent = option.label;
      element.label = option.label;
      element.disabled = !!option.disabled;
      return element;
    });
    const groupElements = Array.from(new Set(options.map(option => option.group).filter(Boolean))).map(group => {
      const element = document.createElement('optgroup');
      element.label = group ?? '';
      options
        .filter(option => option.group === group)
        .forEach(option => {
          const child = document.createElement('option');
          child.value = option.value;
          child.textContent = option.label;
          child.label = option.label;
          child.disabled = !!option.disabled;
          element.appendChild(child);
        });
      return element;
    });

    Object.defineProperty(trigger, 'options', {
      configurable: true,
      get: () => hiddenSelectRef.current?.options ?? optionElements,
    });
    Object.defineProperty(trigger, 'selectedIndex', {
      configurable: true,
      get: () => selectedIndex,
    });
    Object.defineProperty(trigger, 'querySelectorAll', {
      configurable: true,
      value: (selector: string) => {
        const optionSelector = selector.match(/^option(?:\[value=(?:"([^"]*)"|'([^']*)'|([^\]]+))\])?$/);
        if (optionSelector) {
          const requestedValue = optionSelector[1] ?? optionSelector[2] ?? optionSelector[3];
          return requestedValue === undefined
            ? optionElements
            : optionElements.filter(option => option.value === requestedValue);
        }
        if (selector === 'optgroup') return groupElements;
        return HTMLElement.prototype.querySelectorAll.call(trigger, selector);
      },
    });
    Object.defineProperty(trigger, 'querySelector', {
      configurable: true,
      value: (selector: string) => {
        const matches = trigger.querySelectorAll(selector);
        return matches[0] ?? null;
      },
    });
  }, [options, selectedIndex]);

  useEffect(() => {
    if (controlledValue === undefined && !options.some(option => option.value === internalValue)) {
      setInternalValue(options[0]?.value ?? '');
    }
  }, [controlledValue, internalValue, options]);

  useEffect(() => {
    setActiveIndex(selectedIndex);
  }, [selectedIndex]);

  useEffect(() => {
    if (!id || ariaLabel || typeof document === 'undefined') {
      setLabelId(undefined);
      return;
    }

    const escapedId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/"/g, '\\"');
    const label = document.querySelector<HTMLLabelElement>(`label[for="${escapedId}"]`);
    if (!label) {
      setLabelId(undefined);
      return;
    }

    if (!label.id) label.id = `${id}-label`;
    setLabelId(label.id);
  }, [ariaLabel, id]);

  useEffect(() => () => {
    if (typeaheadTimeoutRef.current) window.clearTimeout(typeaheadTimeoutRef.current);
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setMenuPosition({
        left: rect.left,
        top: rect.bottom + 4,
        minWidth: rect.width,
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);

    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [isOpen]);

  const handleSelect = useCallback((nextValue: string) => {
    const option = options.find(candidate => candidate.value === nextValue);
    if (option?.disabled) return;

    if (controlledValue === undefined) setInternalValue(nextValue);
    onChange?.({
      target: { value: nextValue, name },
      currentTarget: { value: nextValue, name },
    });
    setIsOpen(false);
    triggerRef.current?.focus();
  }, [controlledValue, name, onChange, options]);

  useEffect(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const handleSyntheticChange = (event: Event) => {
      handleSelect((event.target as HTMLButtonElement).value);
    };

    trigger.addEventListener('change', handleSyntheticChange);
    return () => trigger.removeEventListener('change', handleSyntheticChange);
  }, [handleSelect]);

  const handleKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;

    const moveActive = (direction: 1 | -1) => {
      const startIndex = isOpen ? activeIndex + direction : selectedIndex + direction;
      const nextIndex = findNextEnabledIndex(startIndex, direction);
      if (nextIndex >= 0) {
        setActiveIndex(nextIndex);
        if (!isOpen) setIsOpen(true);
      }
    };

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveActive(1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        moveActive(-1);
        return;
      case 'Home': {
        event.preventDefault();
        const nextIndex = findNextEnabledIndex(0, 1);
        if (nextIndex >= 0) {
          setActiveIndex(nextIndex);
          if (!isOpen) setIsOpen(true);
        }
        return;
      }
      case 'End': {
        event.preventDefault();
        const nextIndex = findNextEnabledIndex(options.length - 1, -1);
        if (nextIndex >= 0) {
          setActiveIndex(nextIndex);
          if (!isOpen) setIsOpen(true);
        }
        return;
      }
      case 'Enter':
      case ' ': {
        event.preventDefault();
        if (!isOpen) {
          openMenu();
          return;
        }
        const activeOption = options[activeIndex];
        if (activeOption) handleSelect(activeOption.value);
        return;
      }
      case 'Escape':
        if (isOpen) {
          event.preventDefault();
          setIsOpen(false);
        }
        return;
      case 'Tab':
        setIsOpen(false);
        return;
      default:
        break;
    }

    if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      typeaheadRef.current += event.key.toLowerCase();
      if (typeaheadTimeoutRef.current) window.clearTimeout(typeaheadTimeoutRef.current);
      typeaheadTimeoutRef.current = window.setTimeout(() => {
        typeaheadRef.current = '';
      }, 500);

      const startIndex = isOpen ? activeIndex + 1 : selectedIndex + 1;
      const searchOrder = [
        ...options.slice(startIndex),
        ...options.slice(0, startIndex),
      ];
      const match = searchOrder.find(option => !option.disabled && option.label.toLowerCase().startsWith(typeaheadRef.current));
      if (!match) return;

      event.preventDefault();
      const matchIndex = options.findIndex(option => option.value === match.value);
      if (matchIndex >= 0) {
        setActiveIndex(matchIndex);
        if (!isOpen) setIsOpen(true);
      }
    }
  };

  let lastGroup: string | undefined;
  const accessibleNameProps = ariaLabel
    ? { 'aria-label': ariaLabel }
    : labelId
      ? { 'aria-labelledby': `${labelId} ${selectedValueId}` }
      : { 'aria-label': selectedOption?.label };

  return (
    <div className={className.includes('w-full') ? 'w-full min-w-0' : 'relative inline-block min-w-0'}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        value={currentValue}
        disabled={disabled}
        onChange={(event) => handleSelect((event.target as HTMLButtonElement).value)}
        onClick={() => {
          if (isOpen) {
            setIsOpen(false);
          } else {
            openMenu();
          }
        }}
        onKeyDown={handleKeyboard}
        title={title}
        {...accessibleNameProps}
        aria-required={required || undefined}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listboxId : undefined}
        aria-activedescendant={isOpen && activeIndex >= 0 ? getOptionId(activeIndex) : undefined}
        className={`${className} ${toolbarControlClass} flex items-center justify-between gap-2 ${className.includes('w-full') ? 'w-full' : 'min-w-28'} ${disabled ? 'opacity-60 cursor-not-allowed hover:bg-bambu-dark' : ''}`}
      >
        <span id={selectedValueId} className="truncate">{selectedOption?.label}</span>
        <ChevronDown className={`w-4 h-4 text-bambu-gray transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      <select
        ref={hiddenSelectRef}
        aria-hidden="true"
        hidden
        tabIndex={-1}
        name={name}
        required={required}
        disabled={disabled}
        value={currentValue}
        onChange={(event) => handleSelect(event.target.value)}
        onInvalid={(event) => {
          event.preventDefault();
          triggerRef.current?.focus();
        }}
        className="absolute h-px w-px opacity-0 pointer-events-none"
      >
        {children}
      </select>

      {isOpen && createPortal(
        <>
          <div className="fixed inset-0 z-10" onClick={() => setIsOpen(false)} />
          <div
            id={listboxId}
            className="fixed z-50 max-h-72 overflow-y-auto rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary py-1 shadow-xl"
            role="listbox"
            aria-labelledby={labelId}
            style={{
              left: menuPosition.left,
              top: menuPosition.top,
              minWidth: menuPosition.minWidth,
            }}
          >
            {options.map(option => {
              const showGroup = option.group && option.group !== lastGroup;
              lastGroup = option.group;

              return (
                <div key={`${option.group ?? ''}:${option.value}`}>
                  {showGroup && (
                    <div className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-bambu-gray">
                      {option.group}
                    </div>
                  )}
                  <button
                    id={getOptionId(options.findIndex(candidate => candidate.value === option.value && candidate.group === option.group))}
                    type="button"
                    role="option"
                    aria-selected={option.value === currentValue}
                    disabled={option.disabled}
                    onClick={() => handleSelect(option.value)}
                    onMouseEnter={() => {
                      const hoveredIndex = options.findIndex(candidate => candidate.value === option.value && candidate.group === option.group);
                      if (hoveredIndex >= 0 && !option.disabled) setActiveIndex(hoveredIndex);
                    }}
                    className={`w-full px-3 py-2 text-left text-sm transition-colors hover:bg-bambu-dark-tertiary disabled:cursor-not-allowed disabled:opacity-50 ${
                      option.value === currentValue ? 'text-bambu-green' : activeIndex >= 0 && options[activeIndex] === option ? 'bg-bambu-dark-tertiary text-white' : 'text-white'
                    }`}
                  >
                    {option.label}
                  </button>
                </div>
              );
            })}
          </div>
        </>,
        document.body
      )}
    </div>
  );
}

export function ToolbarMenu({
  label,
  icon,
  children,
}: {
  label: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(open => !open)}
        className={toolbarIconButtonClass}
        aria-label={label}
        title={label}
      >
        {icon}
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setIsOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-1 min-w-40 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary p-2 shadow-xl">
            {children}
          </div>
        </>
      )}
    </div>
  );
}
