export function median(values = []) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function theilSenSlope(samples = [], selector = (sample) => sample.value) {
  const slopes = [];
  for (let left = 0; left < samples.length; left += 1) {
    for (let right = left + 1; right < samples.length; right += 1) {
      const requestDelta = samples[right].requests - samples[left].requests;
      if (requestDelta <= 0) continue;
      slopes.push((selector(samples[right]) - selector(samples[left])) / requestDelta);
    }
  }
  return median(slopes);
}

export function positiveGrowth(finalValue, initialValue) {
  return Math.max(0, Number(finalValue || 0) - Number(initialValue || 0));
}
