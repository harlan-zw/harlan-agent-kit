export type Result<Value, ErrorValue>
  = | { _tag: 'Ok', value: Value }
    | { _tag: 'Err', error: ErrorValue }

export const ok = <Value>(value: Value): Result<Value, never> => ({ _tag: 'Ok', value })

export const err = <ErrorValue>(error: ErrorValue): Result<never, ErrorValue> => ({ _tag: 'Err', error })
