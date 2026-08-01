export function median(values: any = []) : any {
  if (values.length === 0) return 0;
  const sorted: any = [...values].sort((left?: any, right?: any) : any => left - right);
  const middle: any = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function theilSenSlope(samples: any = [], selector: any = (sample?: any) : any => sample.value) : any {
  const slopes: any[] = [];
  for (let left: any = 0; left < samples.length; left += 1) {
    for (let right: any = left + 1; right < samples.length; right += 1) {
      const requestDelta: any = samples[right].requests - samples[left].requests;
      if (requestDelta <= 0) continue;
      slopes.push((selector(samples[right]) - selector(samples[left])) / requestDelta);
    }
  }
  return median(slopes);
}

export function positiveGrowth(finalValue?: any, initialValue?: any) : any {
  return Math.max(0, Number(finalValue || 0) - Number(initialValue || 0));
}
