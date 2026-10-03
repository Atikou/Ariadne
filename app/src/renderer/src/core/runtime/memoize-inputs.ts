/** Bounded to the current inputs; old histories are not retained. */
export function memoizeInputs<T extends readonly unknown[], R>(derive: (...inputs: T) => R): (...inputs: T) => R {
  let previous: T | undefined;
  let result: R;
  return (...inputs) => {
    if (previous === undefined || inputs.some((value, index) => !Object.is(value, previous![index]))) {
      result = derive(...inputs);
      previous = inputs;
    }
    return result;
  };
}
