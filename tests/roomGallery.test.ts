import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoomGallery } from '../src/console/roomGallery.ts';

test('the gallery lists her drawings from both places and serves only files inside her room', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-world-gallery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '画'));
  writeFileSync(join(root, '画', '自拍.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(root, '我.jpg'), Buffer.from([0xff, 0xd8, 0xff]));
  writeFileSync(join(root, '笔记.md'), 'not a picture');

  const gallery = createRoomGallery(root);
  const page = gallery.list(10, 0);
  assert.equal(page.total, 2, 'only images count, from both the drawing folder and the room root');
  assert.deepEqual(page.paintings.map(p => p.name).sort(), ['我.jpg', '自拍.png']);
  assert.equal(page.hasMore, false);

  assert.equal(gallery.list(1, 0).hasMore, true, 'a page smaller than the total reports more');
  assert.equal(gallery.list(1, 1).paintings.length, 1);

  assert.equal(gallery.read('画/自拍.png')?.mediaType, 'image/png');
  assert.equal(gallery.read('我.jpg')?.mediaType, 'image/jpeg');
  assert.equal(gallery.read('笔记.md'), undefined, 'non-images are not served');
  assert.equal(gallery.read('../secret.png'), undefined, 'nothing outside her room is served');
  assert.equal(gallery.read('画/不存在.png'), undefined);
});

test('a copy of the same drawing in the room root is not listed twice', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-world-gallery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '画'));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  writeFileSync(join(root, '画', '头像.png'), png);
  writeFileSync(join(root, '头像.png'), png);        // 她自己 cp 过来的同一张
  writeFileSync(join(root, '头像-旧.png'), png);     // 不同名，照常单独列

  const gallery = createRoomGallery(root);
  const page = gallery.list(10, 0);
  assert.equal(page.total, 2, 'the same-name same-size copy is not a second painting');
  assert.deepEqual(page.paintings.map(p => p.id).sort(), ['头像-旧.png', '画/头像.png']);
  // 另一份同名但内容不同（大小不同）时不算副本，两张都保留
  writeFileSync(join(root, '头像.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
  assert.equal(createRoomGallery(root).list(10, 0).total, 3);
});

