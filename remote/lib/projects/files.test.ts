import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMock = vi.hoisted(() => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  mkdir: vi.fn(),
  deleteFile: vi.fn(),
  rmdir: vi.fn(),
  getUri: vi.fn(),
}));
const nativeMock = vi.hoisted(() => ({ writeTextAtomic: vi.fn() }));
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Data: 'DATA' },
  Encoding: { UTF8: 'utf8' },
  Filesystem: fsMock,
}));
vi.mock('../native', () => ({ KopernikadrNative: nativeMock }));

import { createAppFileAdapter } from './files';

const missing = () => new Error('File does not exist');

describe('createAppFileAdapter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads under Directory.Data/kopernikadr; a missing file is null; other errors propagate', async () => {
    const a = createAppFileAdapter();
    fsMock.readFile.mockResolvedValueOnce({ data: 'hi' });
    expect(await a.readText('index.json')).toBe('hi');
    expect(fsMock.readFile).toHaveBeenCalledWith({ directory: 'DATA', path: 'kopernikadr/index.json', encoding: 'utf8' });
    fsMock.readFile.mockRejectedValueOnce(missing());
    expect(await a.readText('x')).toBeNull();
    fsMock.readFile.mockRejectedValueOnce(new Error('EIO'));
    await expect(a.readText('x')).rejects.toThrow('EIO');
  });

  it('writes atomically through KopernikadrNative with the store-relative path', async () => {
    await createAppFileAdapter().writeTextAtomic('projects/a/project.json', '{}');
    expect(nativeMock.writeTextAtomic).toHaveBeenCalledWith({ path: 'projects/a/project.json', text: '{}' });
  });

  it('list returns names, [] for a missing dir', async () => {
    const a = createAppFileAdapter();
    fsMock.readdir.mockResolvedValueOnce({ files: [{ name: 'a' }, { name: 'b' }] });
    expect(await a.list('projects')).toEqual(['a', 'b']);
    fsMock.readdir.mockRejectedValueOnce(missing());
    expect(await a.list('nope')).toEqual([]);
  });

  it('mkdir is recursive and tolerates "already exists"; remove is idempotent', async () => {
    const a = createAppFileAdapter();
    fsMock.mkdir.mockRejectedValueOnce(new Error('Directory already exists'));
    await a.mkdir('projects/a');
    expect(fsMock.mkdir).toHaveBeenCalledWith({ directory: 'DATA', path: 'kopernikadr/projects/a', recursive: true });
    fsMock.deleteFile.mockRejectedValueOnce(missing());
    await a.remove('x');
    await a.remove('projects/a', { recursive: true });
    expect(fsMock.rmdir).toHaveBeenCalledWith({ directory: 'DATA', path: 'kopernikadr/projects/a', recursive: true });
    fsMock.deleteFile.mockRejectedValueOnce(new Error('EIO'));
    await expect(a.remove('y')).rejects.toThrow('EIO');
  });

  it('uri', async () => {
    fsMock.getUri.mockResolvedValueOnce({ uri: 'file:///x' });
    expect(await createAppFileAdapter().uri('tmp/a')).toBe('file:///x');
  });
});
