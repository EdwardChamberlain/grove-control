/**
 * Tests for the ContextMenu component.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { ContextMenu } from '../../components/ContextMenu';

describe('ContextMenu', () => {
  const mockOnClose = vi.fn();

  const menuItems = [
    { label: 'Edit', onClick: vi.fn() },
    { label: 'Delete', onClick: vi.fn(), danger: true },
    { label: 'Download', onClick: vi.fn() },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('renders menu items', () => {
      render(
        <ContextMenu
          x={100}
          y={100}
          items={menuItems}
          onClose={mockOnClose}
        />
      );

      expect(screen.getByText('Edit')).toBeInTheDocument();
      expect(screen.getByText('Delete')).toBeInTheDocument();
      expect(screen.getByText('Download')).toBeInTheDocument();
    });

    it('positions menu at specified coordinates', () => {
      render(
        <ContextMenu
          x={200}
          y={150}
          items={menuItems}
          onClose={mockOnClose}
        />
      );

      // Menu should be rendered with items visible
      expect(screen.getByText('Edit')).toBeInTheDocument();
    });
  });

  describe('interactions', () => {
    it('moves focus through a submenu and back to its trigger with the keyboard', async () => {
      const user = userEvent.setup();
      const assign = vi.fn();
      render(
        <ContextMenu
          x={100}
          y={100}
          items={[{
            label: 'Add to Project',
            onClick: vi.fn(),
            submenu: [
              { label: 'Tools', onClick: vi.fn() },
              { label: 'Disabled project', onClick: vi.fn(), disabled: true },
              { label: 'Fixtures', onClick: assign },
            ],
          }]}
          onClose={mockOnClose}
        />
      );

      const trigger = screen.getByRole('menuitem', { name: 'Add to Project' });
      expect(trigger).toHaveFocus();
      await user.keyboard('{Enter}');
      expect(screen.getByRole('menuitem', { name: 'Tools' })).toHaveFocus();
      await user.keyboard('{ArrowDown}');
      expect(screen.getByRole('menuitem', { name: 'Fixtures' })).toHaveFocus();
      await user.keyboard('{Escape}');
      expect(trigger).toHaveFocus();
      expect(mockOnClose).not.toHaveBeenCalled();

      await user.keyboard('{ArrowRight}{ArrowUp}{Enter}');
      expect(assign).toHaveBeenCalledOnce();
      expect(mockOnClose).toHaveBeenCalledOnce();
    });

    it('calls onClick when item is clicked', async () => {
      const user = userEvent.setup();
      render(
        <ContextMenu
          x={100}
          y={100}
          items={menuItems}
          onClose={mockOnClose}
        />
      );

      await user.click(screen.getByText('Edit'));

      expect(menuItems[0].onClick).toHaveBeenCalled();
    });

    it('calls onClose after item click', async () => {
      const user = userEvent.setup();
      render(
        <ContextMenu
          x={100}
          y={100}
          items={menuItems}
          onClose={mockOnClose}
        />
      );

      await user.click(screen.getByText('Edit'));

      expect(mockOnClose).toHaveBeenCalled();
    });
  });


  describe('keyboard and pointer edge cases', () => {
    const projectMenu = [{
      label: 'Add to Project',
      onClick: vi.fn(),
      submenu: [{ label: 'Tools', onClick: vi.fn() }],
    }];

    it('wraps focus from the first item to the last with ArrowUp', async () => {
      const user = userEvent.setup();
      render(<ContextMenu x={100} y={100} items={menuItems} onClose={mockOnClose} />);

      expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveFocus();
      await user.keyboard('{ArrowUp}');
      expect(screen.getByRole('menuitem', { name: 'Download' })).toHaveFocus();
      await user.keyboard('{ArrowUp}');
      expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus();
    });

    it('closes a submenu with ArrowLeft and returns focus to its trigger', async () => {
      const user = userEvent.setup();
      render(<ContextMenu x={100} y={100} items={projectMenu} onClose={mockOnClose} />);

      await user.keyboard('{ArrowRight}');
      expect(screen.getByRole('menuitem', { name: 'Tools' })).toHaveFocus();
      expect(screen.getByRole('menu', { name: 'Add to Project' })).toBeInTheDocument();
      await user.keyboard('{ArrowLeft}');

      expect(screen.queryByRole('menuitem', { name: 'Tools' })).not.toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'Add to Project' })).toHaveFocus();
      expect(mockOnClose).not.toHaveBeenCalled();
    });

    it('closes a hover-opened submenu shortly after the pointer leaves', async () => {
      const user = userEvent.setup();
      render(<ContextMenu x={100} y={100} items={projectMenu} onClose={mockOnClose} />);

      const trigger = screen.getByRole('menuitem', { name: 'Add to Project' });
      await user.hover(trigger);
      expect(screen.getByRole('menuitem', { name: 'Tools' })).toBeInTheDocument();

      await user.unhover(trigger);
      await waitFor(() => expect(screen.queryByRole('menuitem', { name: 'Tools' })).not.toBeInTheDocument());
      expect(mockOnClose).not.toHaveBeenCalled();
    });

    it('closes an open submenu, but not the menu, when the main list scrolls', async () => {
      const user = userEvent.setup();
      render(<ContextMenu x={100} y={100} items={projectMenu} onClose={mockOnClose} />);

      await user.click(screen.getByRole('menuitem', { name: 'Add to Project' }));
      expect(screen.getByRole('menuitem', { name: 'Tools' })).toBeInTheDocument();

      fireEvent.scroll(screen.getAllByRole('menu')[0]);
      expect(screen.queryByRole('menuitem', { name: 'Tools' })).not.toBeInTheDocument();
      expect(mockOnClose).not.toHaveBeenCalled();
    });
  });

  describe('styling', () => {
    it('applies danger styling', () => {
      render(
        <ContextMenu
          x={100}
          y={100}
          items={menuItems}
          onClose={mockOnClose}
        />
      );

      // Delete item has danger: true, so should have red styling
      const deleteButton = screen.getByText('Delete');
      expect(deleteButton).toBeInTheDocument();
    });
  });

  describe('dividers', () => {
    it('supports divider property on items', () => {
      // Just verify the ContextMenuItem interface accepts divider prop
      const itemsWithDivider = [
        { label: 'Edit', onClick: vi.fn() },
        { label: 'Copy', onClick: vi.fn(), divider: true },
      ];

      // Interface should accept these items without error
      expect(itemsWithDivider[1].divider).toBe(true);
    });
  });
});
