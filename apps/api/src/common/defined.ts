/**
 * Копия объекта без полей со значением undefined.
 * DTO после ValidationPipe(transform) содержит ВСЕ описанные поля, непереданные — как undefined;
 * при слиянии `{ ...before, ...dto }` они затирают сохранённые значения.
 */
export function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
