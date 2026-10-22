import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, sessionWith } from '@/test/render';
import { ApiError } from '@/services/api-error';
import { filesService } from '@/services/files.service';
import { ImageUpload } from './image-upload';

vi.mock('@/services/files.service', async (original) => {
  const actual = await original<typeof import('@/services/files.service')>();
  return {
    ...actual,
    filesService: {
      upload: vi.fn(),
      get: vi.fn(),
      remove: vi.fn(),
      publicUrl: (id: string | null | undefined) => (id ? `https://api.test/api/v1/public/files/${id}` : null),
    },
  };
});

const upload = vi.mocked(filesService.upload);
const get = vi.mocked(filesService.get);
const remove = vi.mocked(filesService.remove);

const session = sessionWith({
  activeCompanyId: 'co-1',
  permissions: new Set(['branch:write']),
  user: { id: 'u-1', email: 'a@example.com', displayName: 'A' },
});

const stored = (overrides: Record<string, unknown> = {}) => ({
  id: 'f-2',
  purpose: 'BRANCH_IMAGE' as const,
  targetId: 'b-1',
  visibility: 'PUBLIC' as const,
  fileName: 'front.png',
  mimeType: 'image/png',
  sizeBytes: 1000,
  width: 400,
  height: 300,
  url: 'https://api.test/api/v1/public/files/f-2',
  urlExpiresAt: null,
  createdAt: '',
  updatedAt: '',
  ...overrides,
});

const png = (size = 1000, type = 'image/png', name = 'front.png') => new File([new Uint8Array(size)], name, { type });

beforeEach(() => {
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: vi.fn() }));
});
afterEach(() => {
  vi.clearAllMocks();
});

const chooser = () => screen.getByLabelText('Choose front') as HTMLInputElement;

describe('ImageUpload', () => {
  it('shows the current public image, and controls only for people who may change it', () => {
    const { rerender } = renderWithProviders(
      <ImageUpload purpose="BRANCH_IMAGE" targetId="b-1" fileId="f-1" label="Front" canEdit />,
      { session },
    );
    expect(screen.getByRole('img', { name: 'Front' })).toHaveAttribute('src', 'https://api.test/api/v1/public/files/f-1');
    expect(screen.getByRole('button', { name: 'Replace' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();

    rerender(<ImageUpload purpose="BRANCH_IMAGE" targetId="b-1" fileId="f-1" label="Front" canEdit={false} />);
    expect(screen.queryByRole('button', { name: 'Replace' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('previews, uploads with progress, and reports the new file', async () => {
    let finish!: (value: ReturnType<typeof stored>) => void;
    upload.mockImplementation((_company, _input, options) => {
      options?.onProgress?.(0.4);
      return new Promise((resolve) => (finish = resolve));
    });
    const onChange = vi.fn();
    renderWithProviders(
      <ImageUpload purpose="BRANCH_IMAGE" targetId="b-1" fileId={null} label="Front" canEdit onChange={onChange} />,
      { session },
    );

    await userEvent.upload(chooser(), png());
    expect(screen.getByRole('img', { name: 'Front preview' })).toHaveAttribute('src', 'blob:preview');
    expect(await screen.findByRole('progressbar', { name: 'Uploading front' })).toHaveAttribute('aria-valuenow', '40');
    expect(upload).toHaveBeenCalledWith('co-1', expect.objectContaining({ purpose: 'BRANCH_IMAGE', targetId: 'b-1' }), expect.anything());

    finish(stored());
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: 'f-2' })));
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('refuses the wrong type or an oversized file without uploading', async () => {
    renderWithProviders(<ImageUpload purpose="BRANCH_IMAGE" targetId="b-1" fileId={null} label="Front" canEdit maxBytes={500} />, {
      session,
    });
    await userEvent.upload(chooser(), png(100, 'image/svg+xml', 'x.svg'), { applyAccept: false });
    expect(await screen.findByRole('alert')).toHaveTextContent('Use a JPEG, PNG or WebP image.');
    await userEvent.upload(chooser(), png(1000));
    expect(await screen.findByRole('alert')).toHaveTextContent('larger than');
    expect(upload).not.toHaveBeenCalled();
  });

  it('shows the server’s verdict on a bad image, without offering a pointless retry', async () => {
    upload.mockRejectedValue(new ApiError({ status: 422, code: 'FILE_INVALID', message: 'The image must be at least 200 × 200 pixels.' }));
    renderWithProviders(<ImageUpload purpose="BRANCH_IMAGE" targetId="b-1" fileId={null} label="Front" canEdit />, { session });
    await userEvent.upload(chooser(), png());
    expect(await screen.findByRole('alert')).toHaveTextContent('at least 200 × 200 pixels');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('retries the same file after a storage outage', async () => {
    upload
      .mockRejectedValueOnce(new ApiError({ status: 503, code: 'STORAGE_UNAVAILABLE', message: 'File storage is unavailable. Nothing was saved; try again.' }))
      .mockResolvedValueOnce(stored());
    const onChange = vi.fn();
    renderWithProviders(
      <ImageUpload purpose="BRANCH_IMAGE" targetId="b-1" fileId={null} label="Front" canEdit onChange={onChange} />,
      { session },
    );
    const file = png();
    await userEvent.upload(chooser(), file);
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[1]![1].file).toBe(file);
  });

  it('removes the image', async () => {
    remove.mockResolvedValue({ removed: true, deleted: true });
    const onChange = vi.fn();
    renderWithProviders(
      <ImageUpload purpose="BRANCH_IMAGE" targetId="b-1" fileId="f-1" label="Front" canEdit onChange={onChange} />,
      { session },
    );
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(null));
    expect(remove).toHaveBeenCalledWith('co-1', 'f-1');
  });

  it('shows a private image through its signed URL', async () => {
    get.mockResolvedValue(stored({ id: 'f-9', visibility: 'PRIVATE', url: 'https://storage.test/signed?sig=abc', urlExpiresAt: 'x' }));
    renderWithProviders(
      <ImageUpload purpose="CUSTOMER_PHOTO" targetId="c-1" fileId="f-9" label="Photo" visibility="PRIVATE" canEdit={false} />,
      { session },
    );
    await waitFor(() => expect(screen.getByRole('img', { name: 'Photo' })).toHaveAttribute('src', 'https://storage.test/signed?sig=abc'));
    expect(get).toHaveBeenCalledWith('co-1', 'f-9', expect.anything());
  });
});
