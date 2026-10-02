'use client';

import { X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCustomers } from '@/features/customers';

export interface PickedCustomer {
  id: string;
  name: string;
}

/**
 * Choose the customer a gift card belongs to, or none.
 *
 * Search-as-you-type against the customer list. The server re-checks that the
 * id belongs to this company, so this is a convenience, not a gate.
 */
export function CustomerPicker(props: {
  id: string;
  label?: string;
  value: PickedCustomer | null;
  onChange: (customer: PickedCustomer | null) => void;
}) {
  const [search, setSearch] = useState('');
  const term = search.trim();
  const customers = useCustomers({ search: term || undefined, limit: 6, status: 'ACTIVE' });
  const results = term.length >= 2 ? (customers.data?.items ?? []) : [];

  if (props.value) {
    return (
      <div className="grid gap-1.5">
        <Label htmlFor={props.id}>{props.label ?? 'Customer'}</Label>
        <div className="flex items-center gap-2">
          <span id={props.id} className="bg-muted rounded-md px-2.5 py-1 text-sm">
            {props.value.name}
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`Remove ${props.value.name}`}
            onClick={() => props.onChange(null)}
          >
            <X aria-hidden className="size-4" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={props.id}>{props.label ?? 'Customer'}</Label>
      <Input
        id={props.id}
        value={search}
        placeholder="Search by name, phone or email"
        autoComplete="off"
        onChange={(e) => setSearch(e.target.value)}
      />
      {results.length > 0 ? (
        <ul
          className="border-border/60 grid rounded-md border text-sm"
          aria-label="Matching customers"
        >
          {results.map((customer) => (
            <li key={customer.id}>
              <button
                type="button"
                className="hover:bg-muted w-full px-2.5 py-1.5 text-left"
                onClick={() => {
                  props.onChange({ id: customer.id, name: customer.fullName });
                  setSearch('');
                }}
              >
                {customer.fullName}
                {customer.phone ? (
                  <span className="text-muted-foreground ml-2 text-xs">{customer.phone}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : term.length >= 2 && !customers.isFetching ? (
        <p className="text-muted-foreground text-xs">No matching customers.</p>
      ) : (
        <p className="text-muted-foreground text-xs">
          Optional — leave empty for an unassigned card.
        </p>
      )}
    </div>
  );
}
