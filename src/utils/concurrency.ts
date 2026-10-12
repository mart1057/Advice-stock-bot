/// Minimal p-limit: caps how many promises run at the same time.
export const createLimiter = (maxConcurrent: number) => {
  if (maxConcurrent < 1) throw new Error('maxConcurrent must be >= 1');

  let active = 0;
  const queue: Array<() => void> = [];

  const next = (): void => {
    active -= 1;
    const resume = queue.shift();
    if (resume) resume();
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= maxConcurrent) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active += 1;
    try {
      return await task();
    } finally {
      next();
    }
  };
};

/// Runs tasks with a concurrency cap and never rejects: each result is tagged.
export const mapWithLimit = async <TIn, TOut>(
  items: readonly TIn[],
  maxConcurrent: number,
  task: (item: TIn, index: number) => Promise<TOut>,
): Promise<Array<{ item: TIn; value: TOut } | { item: TIn; error: unknown }>> => {
  const limit = createLimiter(maxConcurrent);
  return Promise.all(
    items.map((item, index) =>
      limit(async () => {
        try {
          return { item, value: await task(item, index) };
        } catch (error) {
          return { item, error };
        }
      }),
    ),
  );
};

export const chunk = <T>(items: readonly T[], size: number): T[][] => {
  if (size < 1) throw new Error('chunk size must be >= 1');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};
