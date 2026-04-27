import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, test, vi } from 'vitest';

import CalendarInfo from '../components/CalendarInfo';

afterEach(() => {
  cleanup();
});

test('lets the user jump to a month and keeps a fixed six-row grid', async () => {
  const onSingleChange = vi.fn();

  const { container } = render(
    <CalendarInfo
      selectionMode="single"
      singleValue="2024-01-15"
      onSingleChange={onSingleChange}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: /2024/i }));

  const monthSelect = screen.getByLabelText(/visible month month/i);
  fireEvent.change(monthSelect, { target: { value: '2' } });

  await waitFor(() => {
    expect(screen.getByLabelText(/visible month month/i)).toHaveValue('2');
  });
  expect(onSingleChange).not.toHaveBeenCalled();
  expect(container.querySelectorAll('.rdp-week')).toHaveLength(6);
});
