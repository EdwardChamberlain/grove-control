import { Children, isValidElement, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
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
  target: { value: string };
  currentTarget: { value: string };
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
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0, minWidth: 0 });
  const options = parseSelectOptions(children);
  const currentValue = Array.isArray(value)
    ? String(value[0] ?? '')
    : value !== undefined
      ? String(value)
      : Array.isArray(defaultValue)
        ? String(defaultValue[0] ?? '')
        : defaultValue !== undefined
          ? String(defaultValue)
          : options[0]?.value ?? '';
  const selectedOption = options.find(option => option.value === currentValue) ?? options[0];

  useEffect(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    Object.defineProperty(trigger, 'options', {
      configurable: true,
      value: options.map(option => ({
        value: option.value,
        textContent: option.label,
        label: option.label,
        disabled: !!option.disabled,
      })),
    });
  }, [options]);

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

  const handleSelect = (nextValue: string) => {
    onChange?.({
      target: { value: nextValue },
      currentTarget: { value: nextValue },
    });
    setIsOpen(false);
  };

  let lastGroup: string | undefined;

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
        onClick={() => setIsOpen(open => !open)}
        title={title}
        aria-label={ariaLabel ?? selectedOption?.label}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        className={`${className} ${toolbarControlClass} flex items-center justify-between gap-2 ${className.includes('w-full') ? 'w-full' : 'min-w-28'} ${disabled ? 'opacity-60 cursor-not-allowed hover:bg-bambu-dark' : ''}`}
      >
        <span className="truncate">{selectedOption?.label}</span>
        <ChevronDown className={`w-4 h-4 text-bambu-gray transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && createPortal(
        <>
          <div className="fixed inset-0 z-10" onClick={() => setIsOpen(false)} />
          <div
            className="fixed z-50 max-h-72 overflow-y-auto rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary py-1 shadow-xl"
            role="listbox"
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
                    type="button"
                    role="option"
                    aria-selected={option.value === currentValue}
                    disabled={option.disabled}
                    onClick={() => handleSelect(option.value)}
                    className={`w-full px-3 py-2 text-left text-sm transition-colors hover:bg-bambu-dark-tertiary disabled:cursor-not-allowed disabled:opacity-50 ${
                      option.value === currentValue ? 'text-bambu-green' : 'text-white'
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
