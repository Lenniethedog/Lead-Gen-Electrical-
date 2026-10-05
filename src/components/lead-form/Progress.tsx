export function Progress({ current, total }: { current: number; total: number }) {
  return (
    <div>
      <p className="text-sm font-semibold text-muted">
        Step {current} of {total}
      </p>
      <div
        role="progressbar"
        aria-label="Form progress"
        aria-valuemin={1}
        aria-valuemax={total}
        aria-valuenow={current}
        aria-valuetext={`Step ${current} of ${total}`}
        className="mt-2 h-2 overflow-hidden rounded-full bg-stone-200"
      >
        <div
          className="h-full rounded-full bg-brand-700 transition-[width] duration-300 motion-reduce:transition-none"
          style={{ width: `${(current / total) * 100}%` }}
        />
      </div>
    </div>
  );
}
