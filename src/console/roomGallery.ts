/** 她画的图：控制台「画作」页只读地列她房间里的图片，并按需把原图发回去。
 *
 * 两个位置都要看：新画用生图接口，落在 `room/画/`；早先自己用 Python 画的散在 `room/` 根目录，
 * 跟脚本和笔记混着。只读、不复制、不改动——她的文件夹归她自己。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';

const MEDIA_TYPES = new Map([['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'], ['.gif', 'image/gif']]);
/** 新图都落在这里；没有这个目录时只看根目录。 */
const PAINTING_DIR = '画';
const MAX_BYTES = 32 * 1024 * 1024;

export interface Painting {
  /** 相对 roomDir 的路径，正斜杠；读图时原样传回。 */
  id: string;
  name: string;
  /** `画` 或 `房间`，只在列表里标明来源。 */
  where: string;
  bytes: number;
  savedAt: string;
}

export function createRoomGallery(roomDir: string) {
  const root = resolve(roomDir);

  /** 一个目录里的图片文件；目录不在或读不了就当没有，不当成错误。 */
  function imagesIn(dir: string, where: string): Painting[] {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return []; }
    const out: Painting[] = [];
    for (const name of entries) {
      const full = join(dir, name);
      try {
        const stat = statSync(full);
        if (!stat.isFile() || !MEDIA_TYPES.has(extname(name).toLowerCase())) continue;
        const id = (where === PAINTING_DIR ? `${PAINTING_DIR}/${name}` : name).split(sep).join('/');
        out.push({ id, name, where, bytes: stat.size, savedAt: stat.mtime.toISOString() });
      } catch { /* 读不到就跳过这一张 */ }
    }
    return out;
  }

  /** 新图在前；同一时刻按名字排，保证分页稳定。 */
  function all(): Painting[] {
    return [...imagesIn(join(root, PAINTING_DIR), PAINTING_DIR), ...imagesIn(root, '房间')]
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt) || a.name.localeCompare(b.name));
  }

  return {
    list(limit: number, offset: number) {
      const paintings = all();
      return { paintings: paintings.slice(offset, offset + limit), total: paintings.length, hasMore: offset + limit < paintings.length };
    },
    /** 只发落在她房间里的图片；`..`、绝对路径、非图片扩展名一律当作不存在。 */
    read(id: string) {
      const full = resolve(root, id);
      if (full !== root && !full.startsWith(root + sep)) return undefined;
      if (!MEDIA_TYPES.has(extname(full).toLowerCase())) return undefined;
      try {
        if (!statSync(full).isFile()) return undefined;
        const data = readFileSync(full);
        if (data.byteLength > MAX_BYTES) return undefined;
        return { mediaType: MEDIA_TYPES.get(extname(full).toLowerCase())!, data };
      } catch { return undefined; }
    },
  };
}
