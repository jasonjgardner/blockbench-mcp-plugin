import { z } from "zod";

type Repeat2<T> = [T, T];
type Repeat3<T> = [T, T, T];
type Repeat4<T> = [T, T, T, T];

/** A fixed-length array schema with tuple-shaped input and output types. */
export interface IFixedArraySchema<T extends unknown[], I extends unknown[]> extends z.ZodType<T, z.ZodTypeDef, I> {}

/**
 * Creates a homogeneous fixed-length array without publishing draft-07 tuple syntax.
 *
 * The runtime schema enforces the requested length while its TypeScript type remains a tuple.
 */
export function fixedArray<E extends z.ZodTypeAny>(element: E, length: 2): IFixedArraySchema<Repeat2<z.output<E>>, Repeat2<z.input<E>>>;
export function fixedArray<E extends z.ZodTypeAny>(element: E, length: 3): IFixedArraySchema<Repeat3<z.output<E>>, Repeat3<z.input<E>>>;
export function fixedArray<E extends z.ZodTypeAny>(element: E, length: 4): IFixedArraySchema<Repeat4<z.output<E>>, Repeat4<z.input<E>>>;
export function fixedArray(element: z.ZodTypeAny, length: number): z.ZodTypeAny {
  return z.array(element).length(length);
}