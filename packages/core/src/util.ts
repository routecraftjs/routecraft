export function overloads<TOptions, TMain>(
  optionsOrMain: TOptions | TMain,
  maybeMain?: TMain,
  defaultOptions: () => TOptions = () => ({}) as TOptions,
): { options: TOptions; main: TMain } {
  if (maybeMain) {
    return {
      options: optionsOrMain as TOptions,
      main: maybeMain,
    };
  }
  return {
    options: defaultOptions(),
    main: optionsOrMain as TMain,
  };
}
