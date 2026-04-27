import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { DayButton, DayPicker } from 'react-day-picker';

import type {
  CustomComponents,
  DateRange,
  DayButtonProps,
  Matcher,
  MonthCaptionProps,
} from 'react-day-picker';
import type { FieldValues, Path, UseFormReturn } from 'react-hook-form';

import 'react-day-picker/style.css';

interface CalendarCommonProps {
  startLabel?: string;
  endLabel?: string;
  className?: string;
  disabledDates?: string[];
  disablePastDates?: boolean;
  allowedDates?: string[];
  dateDetails?: Record<string, string>;
  showTopLabels?: boolean;
}

type CalendarSelectionMode = 'range' | 'multiple' | 'single';
type PickerPlacement = 'top' | 'bottom';
const POPOVER_ANIMATION_DURATION_MS = 160;
const MONTH_OPTIONS = [
  { value: 1, label: 'January' },
  { value: 2, label: 'February' },
  { value: 3, label: 'March' },
  { value: 4, label: 'April' },
  { value: 5, label: 'May' },
  { value: 6, label: 'June' },
  { value: 7, label: 'July' },
  { value: 8, label: 'August' },
  { value: 9, label: 'September' },
  { value: 10, label: 'October' },
  { value: 11, label: 'November' },
  { value: 12, label: 'December' },
];

interface CalendarDateRangeValue {
  from: string;
  to: string;
}

interface CalendarFormProps<T extends FieldValues> extends CalendarCommonProps {
  form: UseFormReturn<T>;
  startName: Path<T>;
  endName: Path<T>;
}

interface CalendarFormSingleProps<T extends FieldValues> extends CalendarCommonProps {
  form: UseFormReturn<T>;
  selectionMode: 'single';
  dateName: Path<T>;
  dateLabel?: string;
  datePlaceholder?: string;
}

interface CalendarControlledRangeProps extends CalendarCommonProps {
  selectionMode?: 'range';
  rangeValue: CalendarDateRangeValue;
  onRangeChange: (value: CalendarDateRangeValue) => void;
  rangeLabel?: string;
  rangePlaceholder?: string;
}

interface CalendarControlledMultipleProps extends CalendarCommonProps {
  selectionMode: 'multiple';
  selectedDates: string[];
  onSelectedDatesChange: (values: string[]) => void;
  multipleLabel?: string;
  multiplePlaceholder?: string;
}

interface CalendarControlledSingleProps extends CalendarCommonProps {
  selectionMode: 'single';
  singleValue: string;
  onSingleChange: (value: string) => void;
  singleLabel?: string;
  singlePlaceholder?: string;
}

type CalendarProps<T extends FieldValues> = CalendarFormProps<T>
  | CalendarFormSingleProps<T>
  | CalendarControlledRangeProps
  | CalendarControlledMultipleProps
  | CalendarControlledSingleProps;

export default function CalendarInfo<T extends FieldValues>({
  startLabel = 'Start Date',
  endLabel = 'End Date',
  className,
  ...props
}: CalendarProps<T>) {
  if ('form' in props) {
    if ('dateName' in props) {
      const singleFormValue = String(props.form.watch(props.dateName) ?? '');

      return (
        <ControlledCalendarInfo
          className={className}
          startLabel={startLabel}
          endLabel={endLabel}
          selectionMode="single"
          singleValue={singleFormValue}
          onSingleChange={(value) => {
            props.form.setValue(props.dateName, value as never, {
              shouldDirty: true,
              shouldTouch: true,
              shouldValidate: true,
            });
          }}
          {...(props.dateLabel ? { singleLabel: props.dateLabel } : {})}
          {...(props.datePlaceholder ? { singlePlaceholder: props.datePlaceholder } : {})}
          {...(props.disabledDates ? { disabledDates: props.disabledDates } : {})}
          {...(props.disablePastDates ? { disablePastDates: props.disablePastDates } : {})}
          {...(props.allowedDates ? { allowedDates: props.allowedDates } : {})}
          {...(props.dateDetails ? { dateDetails: props.dateDetails } : {})}
        />
      );
    }

    const formClassName = className ?? 'relative overflow-visible';
    const formStartValue = String(props.form.watch(props.startName) ?? '');
    const formEndValue = String(props.form.watch(props.endName) ?? '');

    return (
      <ControlledCalendarInfo
        className={formClassName}
        startLabel={startLabel}
        endLabel={endLabel}
        selectionMode="range"
        rangeValue={{
          from: formStartValue,
          to: formEndValue,
        }}
        onRangeChange={({ from, to }) => {
          props.form.setValue(props.startName, from as never, {
            shouldDirty: true,
            shouldTouch: true,
            shouldValidate: true,
          });
          props.form.setValue(props.endName, to as never, {
            shouldDirty: true,
            shouldTouch: true,
            shouldValidate: true,
          });
        }}
        rangeLabel={`${startLabel} - ${endLabel}`}
        {...(props.disabledDates ? { disabledDates: props.disabledDates } : {})}
        {...(props.disablePastDates ? { disablePastDates: props.disablePastDates } : {})}
        {...(props.allowedDates ? { allowedDates: props.allowedDates } : {})}
        {...(props.dateDetails ? { dateDetails: props.dateDetails } : {})}
      />
    );
  }

  const controlledModeProps = props.selectionMode === 'multiple'
    ? {
        selectionMode: 'multiple' as const,
        selectedDates: props.selectedDates,
        onSelectedDatesChange: props.onSelectedDatesChange,
        multipleLabel: props.multipleLabel,
        multiplePlaceholder: props.multiplePlaceholder,
      }
    : props.selectionMode === 'single'
      ? {
          selectionMode: 'single' as const,
          singleValue: props.singleValue,
          onSingleChange: props.onSingleChange,
          singleLabel: props.singleLabel,
          singlePlaceholder: props.singlePlaceholder,
        }
      : {
          rangeValue: props.rangeValue,
          onRangeChange: props.onRangeChange,
          rangeLabel: props.rangeLabel,
          rangePlaceholder: props.rangePlaceholder,
        };

  return (
    <ControlledCalendarInfo
      className={className}
      startLabel={startLabel}
      endLabel={endLabel}
      {...controlledModeProps}
      disabledDates={props.disabledDates}
      disablePastDates={props.disablePastDates}
      allowedDates={props.allowedDates}
      dateDetails={props.dateDetails}
    />
  );
}

function getDatePart(value: string) {
  return value.split('T')[0] ?? '';
}

function parseDatePartToLocalDate(datePart: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart);
  if (!match) return undefined;

  const [, yearRaw, monthRaw, dayRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const parsed = new Date(year, month - 1, day);

  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function parseSelectedDate(value: string) {
  const datePart = getDatePart(value);
  if (!datePart) return undefined;

  return parseDatePartToLocalDate(datePart);
}

function formatInputDate(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');

  return `${year}-${month}-${day}`;
}

function getMonthStart(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function parsePositiveInteger(value: string) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

function MonthYearCaptionControls({
  value,
  onChange,
}: {
  value: Date;
  onChange: (nextMonth: Date) => void;
}) {
  const [yearInput, setYearInput] = useState(value.getFullYear().toString());
  useEffect(() => {
    setYearInput(value.getFullYear().toString());
  }, [value]);

  return (
    <div className="mx-auto flex w-full items-center gap-1.5">
      <button
        type="button"
        className="btn btn-ghost btn-sm btn-square"
        aria-label="Previous month"
        onClick={() => onChange(new Date(value.getFullYear(), value.getMonth() - 1, 1))}
      >
        <ChevronLeft size={16} />
      </button>

      <div className="flex flex-1 items-center gap-1">
        <select
          className="select select-bordered select-sm flex-1 min-w-0 text-sm basis-0 w-0! pr-3"
          aria-label="Visible month month"
          value={value.getMonth() + 1}
          onChange={(event) => {
            const nextValue = parsePositiveInteger(event.target.value);
            if (!nextValue) return;

            onChange(new Date(value.getFullYear(), nextValue - 1, 1));
          }}
        >
          {MONTH_OPTIONS.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <input
          type="number"
          min={1}
          max={9999}
          className="input input-bordered input-sm flex-1 min-w-0 text-sm basis-0 w-0!"
          aria-label="Visible month year"
          value={yearInput}
          onChange={(event) => {
            setYearInput(event.target.value);
          }}
          onBlur={() => {
            const parsed = parsePositiveInteger(yearInput);

            if (!parsed) {
              setYearInput(value.getFullYear().toString());
              return;
            }

            onChange(new Date(parsed, value.getMonth(), 1));
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const parsed = parsePositiveInteger(yearInput);
              if (parsed) {
                onChange(new Date(parsed, value.getMonth(), 1));
              }
            }
          }}
        />
      </div>

      <button
        type="button"
        className="btn btn-ghost btn-sm btn-square"
        aria-label="Next month"
        onClick={() => onChange(new Date(value.getFullYear(), value.getMonth() + 1, 1))}
      >
        <ChevronRight size={16} />
      </button>
    </div>
  );
}

function buildNextValue(date: Date) {
  return formatInputDate(date);
}

function getSortedRange(from: Date, to: Date): DateRange {
  if (from.getTime() <= to.getTime()) {
    return { from, to };
  }

  return { from: to, to: from };
}

function DayButtonWithDetails({
  detailsByDate,
  children,
  day,
  ...props
}: DayButtonProps & {
  detailsByDate: Record<string, string>;
}) {
  const detail = detailsByDate[formatInputDate(day.date)];

  return (
    <DayButton day={day} {...props}>
      <span className="willing-day-content">
        <span>{children}</span>
        {detail && <span className="willing-day-detail">{detail}</span>}
      </span>
    </DayButton>
  );
}

function ControlledCalendarInfo({
  startLabel,
  endLabel,
  className,
  showTopLabels = true,
  selectionMode,
  disabledDates,
  disablePastDates,
  allowedDates,
  dateDetails,
  rangeValue,
  onRangeChange,
  rangeLabel,
  rangePlaceholder,
  selectedDates,
  onSelectedDatesChange,
  multipleLabel,
  multiplePlaceholder,
  singleValue,
  onSingleChange,
  singleLabel,
  singlePlaceholder,
}: {
  selectionMode?: CalendarSelectionMode;
  disabledDates?: string[];
  disablePastDates?: boolean;
  allowedDates?: string[];
  dateDetails?: Record<string, string>;
  rangeValue?: CalendarDateRangeValue;
  onRangeChange?: (value: CalendarDateRangeValue) => void;
  rangeLabel?: string;
  rangePlaceholder?: string;
  selectedDates?: string[];
  onSelectedDatesChange?: (values: string[]) => void;
  multipleLabel?: string;
  multiplePlaceholder?: string;
  singleValue?: string;
  onSingleChange?: (value: string) => void;
  singleLabel?: string;
  singlePlaceholder?: string;
} & {
  startLabel: string;
  endLabel: string;
  className?: string;
  showTopLabels?: boolean;
}) {
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [isPickerClosing, setIsPickerClosing] = useState(false);
  const [rangeHoverDate, setRangeHoverDate] = useState<Date>();
  const [pickerMonth, setPickerMonthState] = useState(getMonthStart(new Date()));
  const [pickerPlacement, setPickerPlacement] = useState<PickerPlacement>('bottom');
  const calendarContainerRef = useRef<HTMLDivElement>(null);
  const startTriggerRef = useRef<HTMLButtonElement>(null);
  const activePopoverRef = useRef<HTMLDivElement>(null);
  const closeTimeoutRef = useRef<number | null>(null);

  const mode = selectionMode ?? 'range';

  const normalizedDateDetails = useMemo(() => {
    if (!dateDetails) return {};

    return Object.entries(dateDetails).reduce<Record<string, string>>((acc, [date, detail]) => {
      const key = getDatePart(date);
      if (key) {
        acc[key] = detail;
      }
      return acc;
    }, {});
  }, [dateDetails]);

  const disabledDateSet = useMemo(() => {
    return new Set((disabledDates ?? []).map(getDatePart).filter(Boolean));
  }, [disabledDates]);
  const allowedDateSet = useMemo(() => {
    return new Set((allowedDates ?? []).map(getDatePart).filter(Boolean));
  }, [allowedDates]);

  const disabledMatchers: Matcher[] | undefined = (() => {
    const matchers: Matcher[] = [];

    if (disablePastDates) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      matchers.push({ before: today });
    }

    if (disabledDateSet.size > 0 || allowedDateSet.size > 0) {
      matchers.push((date: Date) => {
        const formattedDate = formatInputDate(date);

        if (disabledDateSet.has(formattedDate)) {
          return true;
        }

        if (allowedDateSet.size > 0 && !allowedDateSet.has(formattedDate)) {
          return true;
        }

        return false;
      });
    }

    return matchers.length > 0 ? matchers : undefined;
  })();

  const dayPickerComponents = Object.keys(normalizedDateDetails).length > 0
    ? {
        DayButton: (dayButtonProps: DayButtonProps) => (
          <DayButtonWithDetails
            {...dayButtonProps}
            detailsByDate={normalizedDateDetails}
          />
        ),
      }
    : undefined;

  const calendarComponents: Partial<CustomComponents> = {
    ...(dayPickerComponents ?? {}),
    MonthCaption: ({ calendarMonth, displayIndex, ...rest }: MonthCaptionProps) => {
      void calendarMonth;
      void displayIndex;

      return (
        <div {...rest} className="rdp-month_caption">
          <MonthYearCaptionControls value={pickerMonth} onChange={setPickerMonth} />
        </div>
      );
    },
  };

  const controlledClassName = className ?? 'relative overflow-visible';
  const actionButtonClassName = 'btn btn-primary btn-sm';
  const secondaryActionButtonClassName = 'btn btn-ghost btn-sm';
  const dateFormatter = new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  const clearCloseTimeout = () => {
    if (closeTimeoutRef.current != null) {
      window.clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
  };

  const beginClosePicker = () => {
    if (!isPickerOpen) return;

    clearCloseTimeout();
    setIsPickerClosing(true);
    closeTimeoutRef.current = window.setTimeout(() => {
      setIsPickerOpen(false);
      setIsPickerClosing(false);
      setRangeHoverDate(undefined);
      closeTimeoutRef.current = null;
    }, POPOVER_ANIMATION_DURATION_MS);
  };

  const setPickerMonth = (month: Date) => {
    setPickerMonthState(getMonthStart(month));
  };

  const openOrTogglePicker = (month?: Date) => {
    if (isPickerOpen && !isPickerClosing) {
      beginClosePicker();
      return;
    }

    clearCloseTimeout();
    setIsPickerClosing(false);
    if (month) {
      setPickerMonth(getMonthStart(month));
    }
    setIsPickerOpen(true);
  };

  useEffect(() => {
    if (!isPickerOpen) return;

    const handleClickOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!calendarContainerRef.current) return;
      if (calendarContainerRef.current.contains(target)) return;

      beginClosePicker();
    };

    document.addEventListener('pointerdown', handleClickOutside);

    return () => {
      document.removeEventListener('pointerdown', handleClickOutside);
    };
  }, [isPickerOpen]);

  useEffect(() => {
    return () => {
      clearCloseTimeout();
    };
  }, []);

  useLayoutEffect(() => {
    if (!isPickerOpen) return;

    const trigger = startTriggerRef.current;
    const popover = activePopoverRef.current;
    if (!trigger || !popover) return;

    const triggerRect = trigger.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const gap = 8;
    const spaceBelow = window.innerHeight - triggerRect.bottom;
    const spaceAbove = triggerRect.top;
    const nextPlacement: PickerPlacement = spaceBelow < popoverRect.height + gap && spaceAbove > spaceBelow
      ? 'top'
      : 'bottom';

    setPickerPlacement(prev => (prev === nextPlacement ? prev : nextPlacement));
  }, [isPickerOpen]);

  const getPopoverPlacementClass = () => {
    return pickerPlacement === 'top' ? 'sm:bottom-full sm:mb-2' : 'sm:top-full sm:mt-2';
  };

  const getPopoverAnimationClass = () => {
    const isClosing = isPickerClosing;

    if (isClosing) {
      return pickerPlacement === 'top'
        ? 'willing-calendar-popover willing-calendar-popover-closing-top pointer-events-none'
        : 'willing-calendar-popover willing-calendar-popover-closing-bottom pointer-events-none';
    }

    return pickerPlacement === 'top'
      ? 'willing-calendar-popover willing-calendar-popover-top'
      : 'willing-calendar-popover willing-calendar-popover-bottom';
  };

  if (mode === 'range') {
    const currentRange = rangeValue ?? { from: '', to: '' };
    const selectedFromDate = parseSelectedDate(currentRange.from);
    const selectedToDate = parseSelectedDate(currentRange.to);

    const selectedRange: DateRange | undefined = selectedFromDate || selectedToDate
      ? {
          from: selectedFromDate,
          to: selectedToDate,
        }
      : undefined;

    const hoverPreviewRange = selectedFromDate && !selectedToDate && rangeHoverDate
      ? getSortedRange(selectedFromDate, rangeHoverDate)
      : undefined;

    const hoverRangeModifiers = hoverPreviewRange
      ? {
          hoverRange: hoverPreviewRange,
          hoverRangeStart: hoverPreviewRange.from,
          hoverRangeEnd: hoverPreviewRange.to,
        }
      : undefined;
    const rangeFieldLabel = rangeLabel ?? `${startLabel} - ${endLabel}`;

    let valueText = rangePlaceholder ?? 'Select range';
    if (selectedFromDate) {
      valueText = dateFormatter.format(selectedFromDate);

      if (selectedToDate) {
        valueText = `${valueText} -> ${dateFormatter.format(selectedToDate)}`;
      }
    }

    const handleRangePreviewHover = (date: Date, disabled?: boolean) => {
      if (disabled || !selectedFromDate || selectedToDate) return;
      setRangeHoverDate(date);
    };

    return (
      <div ref={calendarContainerRef} className={controlledClassName}>
        <fieldset className="fieldset w-full">
          <div className="relative">
            {showTopLabels && (
              <label className="label mb-1">
                <span className="label-text font-medium">{rangeFieldLabel}</span>
              </label>
            )}
            <button
              ref={startTriggerRef}
              type="button"
              className="input input-bordered flex w-full items-center justify-between gap-2"
              onClick={() => openOrTogglePicker(selectedFromDate ?? selectedToDate ?? new Date())}
            >
              <span className="truncate text-left">{valueText}</span>
              <CalendarDays size={16} className="shrink-0 opacity-70" />
            </button>

            {isPickerOpen && (
              <div
                ref={activePopoverRef}
                className={`
                  fixed inset-x-4 top-20 z-500 max-w-md mx-auto
                  sm:absolute sm:top-auto sm:inset-x-auto sm:left-0 sm:translate-x-0 sm:mx-0 sm:w-auto sm:min-w-[20rem]
                  rounded-box border border-base-300 bg-base-100 p-3 shadow-xl
                  ${getPopoverPlacementClass()}
                  ${getPopoverAnimationClass()}
                `}
              >
                <DayPicker
                  className="willing-day-picker w-full"
                  style={{ maxHeight: '75vh', overflowY: 'auto', width: '100%' }}
                  mode="range"
                  selected={selectedRange}
                  disabled={disabledMatchers}
                  excludeDisabled={Boolean(disabledMatchers)}
                  fixedWeeks
                  showOutsideDays
                  hideNavigation
                  month={pickerMonth}
                  onMonthChange={setPickerMonth}
                  modifiers={hoverRangeModifiers}
                  modifiersClassNames={{
                    hoverRange: 'willing-hover-range',
                    hoverRangeStart: 'willing-hover-range-start',
                    hoverRangeEnd: 'willing-hover-range-end',
                  }}
                  components={calendarComponents}
                  onDayMouseEnter={(date, modifiers) => {
                    handleRangePreviewHover(date, modifiers.disabled);
                  }}
                  onDayMouseLeave={() => setRangeHoverDate(undefined)}
                  onSelect={(range) => {
                    if (!onRangeChange) return;

                    setRangeHoverDate(undefined);

                    const nextFrom = range?.from
                      ? buildNextValue(range.from)
                      : '';
                    const nextTo = range?.to
                      ? buildNextValue(range.to)
                      : '';

                    onRangeChange({
                      from: nextFrom,
                      to: nextTo,
                    });
                  }}
                />

                <div className="mt-3 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    className={secondaryActionButtonClassName}
                    onClick={() => setPickerMonth(new Date())}
                  >
                    Today
                  </button>

                  <div className="ml-auto flex items-center gap-2">
                    <button
                      type="button"
                      className={secondaryActionButtonClassName}
                      onClick={() => onRangeChange?.({ from: '', to: '' })}
                    >
                      Clear
                    </button>

                    <button
                      type="button"
                      className={actionButtonClassName}
                      onClick={beginClosePicker}
                    >
                      Done
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </fieldset>
      </div>
    );
  }

  const selectedDateValues = selectedDates ?? [];
  const parsedSelectedDates = selectedDateValues
    .map(parseSelectedDate)
    .filter((date): date is Date => Boolean(date));

  if (mode === 'single') {
    const selectedDate = parseSelectedDate(singleValue ?? '');
    const singleFieldLabel = singleLabel ?? startLabel;
    const singleText = selectedDate
      ? dateFormatter.format(selectedDate)
      : (singlePlaceholder ?? singleFieldLabel);

    return (
      <div ref={calendarContainerRef} className={controlledClassName}>
        <fieldset className="fieldset w-full">
          <div className="relative">
            {showTopLabels && (
              <label className="label mb-1">
                <span className="label-text font-medium">{singleFieldLabel}</span>
              </label>
            )}
            <button
              ref={startTriggerRef}
              type="button"
              className="input input-bordered flex w-full items-center justify-between gap-2"
              onClick={() => openOrTogglePicker(selectedDate ?? new Date())}
            >
              <span className="truncate text-left">{singleText}</span>
              <CalendarDays size={16} className="shrink-0 opacity-70" />
            </button>

            {isPickerOpen && (
              <div
                ref={activePopoverRef}
                className={`
                  fixed inset-x-4 top-20 z-500 max-w-md mx-auto
                  sm:absolute sm:top-auto sm:inset-x-auto sm:left-0 sm:translate-x-0 sm:mx-0 sm:w-auto sm:min-w-[20rem]
                  rounded-box border border-base-300 bg-base-100 p-3 shadow-xl
                  ${getPopoverPlacementClass()}
                  ${getPopoverAnimationClass()}
                `}
              >
                <DayPicker
                  className="willing-day-picker w-full"
                  style={{ width: '100%' }}
                  mode="single"
                  selected={selectedDate}
                  disabled={disabledMatchers}
                  fixedWeeks
                  showOutsideDays
                  hideNavigation
                  month={pickerMonth}
                  onMonthChange={setPickerMonth}
                  components={calendarComponents}
                  onSelect={(date) => {
                    if (!onSingleChange) return;

                    onSingleChange(date ? buildNextValue(date) : '');
                    if (date) {
                      beginClosePicker();
                    }
                  }}
                />

                <div className="mt-3 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    className={secondaryActionButtonClassName}
                    onClick={() => setPickerMonth(new Date())}
                  >
                    Today
                  </button>

                  <div className="ml-auto flex items-center gap-2">
                    <button
                      type="button"
                      className={secondaryActionButtonClassName}
                      onClick={() => onSingleChange?.('')}
                    >
                      Clear
                    </button>

                    <button
                      type="button"
                      className={actionButtonClassName}
                      onClick={beginClosePicker}
                    >
                      Done
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </fieldset>
      </div>
    );
  }

  const MAX_DISPLAYED_DATES = 4;
  const allSelectedDateText = parsedSelectedDates.map(date => dateFormatter.format(date)).join(', ');
  const dateListText = parsedSelectedDates.length === 0
    ? (multiplePlaceholder ?? 'Select dates')
    : parsedSelectedDates.length <= MAX_DISPLAYED_DATES
      ? allSelectedDateText
      : `${parsedSelectedDates.slice(0, MAX_DISPLAYED_DATES).map(date => dateFormatter.format(date)).join(', ')} +${parsedSelectedDates.length - MAX_DISPLAYED_DATES} more`;
  const multipleFieldLabel = multipleLabel ?? 'Selected Dates';

  return (
    <div ref={calendarContainerRef} className={controlledClassName}>
      <fieldset className="fieldset w-full">
        <div className="relative">
          {showTopLabels && (
            <label className="label mb-1">
              <span className="label-text font-medium">{multipleFieldLabel}</span>
            </label>
          )}
          <button
            ref={startTriggerRef}
            type="button"
            className="input input-bordered flex w-full items-center justify-between gap-2"
            onClick={() => openOrTogglePicker(parsedSelectedDates[0] ?? new Date())}
          >
            <span className="truncate overflow-hidden whitespace-nowrap text-ellipsis block max-w-[calc(100%-2.5rem)]" title={allSelectedDateText || dateListText}>{dateListText}</span>
            <CalendarDays size={16} className="shrink-0 opacity-70" />
          </button>

          {isPickerOpen && (
            <div
              ref={activePopoverRef}
              className={`
                fixed inset-x-4 top-20 z-500 max-w-md mx-auto
                sm:absolute sm:top-auto sm:inset-x-auto sm:left-0 sm:translate-x-0 sm:mx-0 sm:w-auto sm:min-w-[20rem]
                rounded-box border border-base-300 bg-base-100 p-3 shadow-xl
                ${getPopoverPlacementClass()}
                ${getPopoverAnimationClass()}
              `}
            >
              <DayPicker
                className="willing-day-picker w-full"
                style={{ width: '100%' }}
                mode="multiple"
                selected={parsedSelectedDates}
                disabled={disabledMatchers}
                fixedWeeks
                showOutsideDays
                hideNavigation
                month={pickerMonth}
                onMonthChange={setPickerMonth}
                components={calendarComponents}
                onSelect={(dates) => {
                  if (!onSelectedDatesChange) return;

                  const nextValues = (dates ?? [])
                    .map(formatInputDate)
                    .sort((left, right) => left.localeCompare(right));

                  onSelectedDatesChange(nextValues);
                }}
              />

              <div className="mt-3 flex items-center justify-between gap-2">
                <button
                  type="button"
                  className={secondaryActionButtonClassName}
                  onClick={() => setPickerMonth(new Date())}
                >
                  Today
                </button>

                <div className="ml-auto flex items-center gap-2">
                  <button
                    type="button"
                    className={secondaryActionButtonClassName}
                    onClick={() => onSelectedDatesChange?.([])}
                  >
                    Clear
                  </button>

                  <button
                    type="button"
                    className={actionButtonClassName}
                    onClick={beginClosePicker}
                  >
                    Done
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </fieldset>
    </div>
  );
}
