
import { useState, useMemo } from 'react';

type SortDirection = 'ascending' | 'descending';

export interface SortConfig<T> {
  key: keyof T | null;
  direction: SortDirection;
}

export const useTableControls = <T extends Record<string, any>>(
  items: T[],
  initialSortConfig: SortConfig<T>,
  searchKeys: (keyof T)[],
  searchTerm: string,
) => {
  const [sortConfig, setSortConfig] = useState<SortConfig<T>>(initialSortConfig);

  const requestSort = (key: keyof T) => {
    let direction: SortDirection = 'ascending';
    if (sortConfig.key === key && sortConfig.direction === 'ascending') {
      direction = 'descending';
    }
    setSortConfig({ key, direction });
  };

  const sortedAndFilteredItems = useMemo(() => {
    let sortableItems = [...items];

    // Filter
    if (searchTerm) {
      sortableItems = sortableItems.filter(item => {
        return searchKeys.some(key => {
          const value = item[key];
          return value && value.toString().toLowerCase().includes(searchTerm.toLowerCase());
        });
      });
    }

    // Sort
    if (sortConfig.key) {
        sortableItems.sort((a, b) => {
            const aValue = a[sortConfig.key!];
            const bValue = b[sortConfig.key!];

            if (aValue === null || aValue === undefined) return 1;
            if (bValue === null || bValue === undefined) return -1;
            
            let comparison: number;
            if (typeof aValue === 'number' && typeof bValue === 'number') {
                comparison = aValue - bValue;
            } else if (typeof aValue === 'object' && aValue !== null && 'name' in aValue) {
                // Heuristic for objects like 'rank' or 'unit'
                comparison = aValue.name.toString().localeCompare(bValue.name.toString(), undefined, { numeric: true });
            } else {
                comparison = aValue.toString().localeCompare(bValue.toString(), undefined, { numeric: true });
            }

            return sortConfig.direction === 'ascending' ? comparison : -comparison;
        });
    }

    return sortableItems;
  }, [items, searchTerm, sortConfig, searchKeys]);

  return { 
    sortedAndFilteredItems, 
    requestSort, 
    sortConfig, 
  };
};
