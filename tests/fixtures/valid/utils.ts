export function calculateTotal(items: number[]) {
  return items.reduce((total, item) => total + item, 0);
}
