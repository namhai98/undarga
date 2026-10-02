/**
 * Small, dependency-free charts for the dashboard and reports.
 *
 * SVG with a viewBox, so they scale to any width — a phone gets the same chart
 * as a desktop, narrower. Every chart also renders its numbers as a visually
 * hidden table: a chart is a picture, and a screen reader deserves the data.
 * Colours are theme tokens (`fill-primary`, …), so dark mode works for free.
 */

export interface ChartSeries {
  key: string;
  label: string;
  /** A Tailwind fill class, e.g. `fill-primary`. */
  fillClass: string;
  /** The matching background class for the legend swatch, e.g. `bg-primary`. */
  swatchClass: string;
}

export interface ChartDatum {
  label: string;
  values: Record<string, number>;
}

/**
 * Vertical bars, stacked by series. Built for a day-by-day series of up to a
 * year; labels thin out so they never overlap.
 */
export function StackedBarChart({
  title,
  data,
  series,
  height = 160,
  formatLabel = (label) => label,
}: {
  title: string;
  data: ChartDatum[];
  series: ChartSeries[];
  height?: number;
  formatLabel?: (label: string) => string;
}) {
  const width = 600;
  const top = 8;
  const bottom = 20;
  const plot = height - top - bottom;
  const totals = data.map((d) => series.reduce((sum, s) => sum + (d.values[s.key] ?? 0), 0));
  const max = Math.max(1, ...totals);
  const slot = width / Math.max(1, data.length);
  const bar = Math.max(1, Math.min(28, slot * 0.7));
  const labelEvery = Math.max(1, Math.ceil(data.length / 8));

  return (
    <figure className="grid gap-2">
      <figcaption className="sr-only">{title}</figcaption>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full overflow-visible"
        role="img"
        aria-label={`${title}: chart. The same figures follow as a table.`}
        preserveAspectRatio="none"
      >
        <line
          x1={0}
          x2={width}
          y1={top + plot}
          y2={top + plot}
          className="stroke-border"
          strokeWidth={1}
        />
        <text
          x={0}
          y={top + 2}
          className="fill-muted-foreground text-[10px]"
          dominantBaseline="hanging"
        >
          {max}
        </text>
        {data.map((d, i) => {
          let y = top + plot;
          const x = i * slot + (slot - bar) / 2;
          return (
            <g key={d.label}>
              {series.map((s) => {
                const value = d.values[s.key] ?? 0;
                if (value === 0) return null;
                const h = (value / max) * plot;
                y -= h;
                return (
                  <rect
                    key={s.key}
                    x={x}
                    y={y}
                    width={bar}
                    height={h}
                    rx={1.5}
                    className={s.fillClass}
                  >
                    <title>{`${formatLabel(d.label)} · ${s.label}: ${value}`}</title>
                  </rect>
                );
              })}
              {i % labelEvery === 0 ? (
                <text
                  x={x + bar / 2}
                  y={height - 4}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[10px]"
                >
                  {formatLabel(d.label)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      {series.length > 1 ? <Legend series={series} /> : null}
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            {series.map((s) => (
              <th key={s.key} scope="col">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.label}>
              <th scope="row">{formatLabel(d.label)}</th>
              {series.map((s) => (
                <td key={s.key}>{d.values[s.key] ?? 0}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** Ranked horizontal bars — "most booked", "top promotions". */
export function RankedBars({
  title,
  items,
  valueLabel = (value) => String(value),
}: {
  title: string;
  items: Array<{ key: string; label: string; value: number; hint?: string }>;
  valueLabel?: (value: number) => string;
}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="grid gap-2" aria-label={title}>
      {items.map((item) => (
        <li key={item.key} className="grid gap-1">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate">{item.label}</span>
            <span className="text-muted-foreground shrink-0 tabular-nums">
              {valueLabel(item.value)}
              {item.hint ? ` · ${item.hint}` : ''}
            </span>
          </div>
          <div className="bg-muted h-1.5 overflow-hidden rounded-full" aria-hidden>
            <div
              className="bg-primary h-full rounded-full"
              style={{ width: `${(item.value / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function Legend({ series }: { series: ChartSeries[] }) {
  return (
    <ul className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-hidden>
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span className={`size-2.5 rounded-sm ${s.swatchClass}`} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

/** Stable, theme-aware colours for up to six series. */
export const SERIES_COLOURS = [
  { fillClass: 'fill-primary', swatchClass: 'bg-primary' },
  { fillClass: 'fill-sky-500', swatchClass: 'bg-sky-500' },
  { fillClass: 'fill-amber-500', swatchClass: 'bg-amber-500' },
  { fillClass: 'fill-violet-500', swatchClass: 'bg-violet-500' },
  { fillClass: 'fill-rose-500', swatchClass: 'bg-rose-500' },
  { fillClass: 'fill-muted-foreground/40', swatchClass: 'bg-muted-foreground/40' },
] as const;
