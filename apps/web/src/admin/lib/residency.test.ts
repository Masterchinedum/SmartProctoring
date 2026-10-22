import type { EvidenceStorageDTO } from '@sp/shared';
import { describe, expect, it } from 'vitest';
import { changeNote, elsewhereNote, locationLabel, locationText, storedSummary } from './residency';

const dto = (current: string, stored: [string, number][]): EvidenceStorageDTO => ({
  current,
  locations: [
    { name: 'default', label: 'Default storage', region: null, isDefault: true },
    { name: 'eu', label: 'EU (Frankfurt)', region: 'eu-central-1', isDefault: false },
    { name: 'uk', label: 'UK (London, eu-west-2)', region: 'eu-west-2', isDefault: false },
  ],
  stored: stored.map(([location, images]) => ({ location, images })),
});

describe('evidence storage location helpers', () => {
  it('names a location by its label, with the region when the label does not already say it', () => {
    expect(locationText({ label: 'Default storage', region: null })).toBe('Default storage');
    expect(locationText({ label: 'EU (Frankfurt)', region: 'eu-central-1' })).toBe('EU (Frankfurt), region eu-central-1');
    expect(locationText({ label: 'UK (London, eu-west-2)', region: 'eu-west-2' })).toBe('UK (London, eu-west-2)');
    expect(locationLabel(dto('eu', []), 'eu')).toBe('EU (Frankfurt)');
    expect(locationLabel(dto('eu', []), 'gone')).toBe('gone');
  });

  it('says how many images each location holds', () => {
    expect(storedSummary(dto('default', [['default', 0], ['eu', 0]]))).toBe('No evidence images are stored at the moment.');
    expect(storedSummary(dto('default', [['default', 1], ['eu', 0]]))).toBe('Stored now: 1 image in Default storage.');
    expect(storedSummary(dto('eu', [['default', 120], ['eu', 36], ['uk', 2]]))).toBe('Stored now: 120 images in Default storage, 36 in EU (Frankfurt) and 2 in UK (London, eu-west-2).');
  });

  it('explains that earlier images stay where they are until the operator moves them', () => {
    expect(elsewhereNote(dto('eu', [['default', 0], ['eu', 5]]))).toBeNull();
    expect(elsewhereNote(dto('eu', [['default', 1], ['eu', 5]]))).toBe(
      '1 earlier image is still stored in Default storage. It stays there, and can be viewed as before, until your server operator moves it to EU (Frankfurt).',
    );
    expect(elsewhereNote(dto('default', [['default', 3], ['eu', 5], ['uk', 2]]))).toBe(
      '7 earlier images are still stored in EU (Frankfurt) and UK (London, eu-west-2). They stay there, and can be viewed as before, until your server operator moves them to Default storage.',
    );
    expect(changeNote(dto('default', []), 'eu')).toBe('From the moment you save, new images are stored in EU (Frankfurt). Images already stored stay where they are until your server operator moves them.');
  });
});
