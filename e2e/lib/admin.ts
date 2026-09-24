import { expect, type Locator, type Page } from '@playwright/test';

/** Staff app helpers (the staff UI has few test ids: selectors use roles, labels and stable classes). */

export async function loginViaUi(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/admin\/login/);
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await expect(page.getByRole('heading', { name: 'Live', exact: true })).toBeVisible();
}

/** The dashboard card of a session (a link to its detail page). */
export function sessionCard(page: Page, sessionId: string): Locator {
  return page.locator(`a.session-card[href="/admin/sessions/${sessionId}"]`);
}

/** Live flags feed entries of one candidate. */
export function feedItems(page: Page, candidateName: string): Locator {
  return page.locator('.feed-item', { hasText: candidateName });
}

export function navLinks(page: Page): Locator {
  return page.locator('.admin-nav nav a');
}

/** The event drawer opened from a list or the feed. */
export function eventDrawer(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Event details' });
}
