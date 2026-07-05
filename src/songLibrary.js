/**
 * songLibrary.js — 歌曲库加载模块
 *
 * 加载 /studio/manifest.json，暴露歌曲列表和当前选中歌曲。
 *
 * 用法：
 *   import { loadSongLibrary, getSongs, getSelectedSong, selectSong } from './songLibrary.js';
 *   await loadSongLibrary();
 *   const songs = getSongs();
 *   selectSong(songs[0].id);
 */

/** @type {Array<{id:string, title:string, file:string, bpm:number, offset:number}>} */
let songs = [];

/** @type {string|null} */
let selectedId = null;

/**
 * 加载歌曲清单
 * @returns {Promise<Array>}
 */
export async function loadSongLibrary() {
  try {
    // 加时间戳避免 dev server 缓存旧 manifest
    const resp = await fetch(`/studio/manifest.json?t=${Date.now()}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    songs = Array.isArray(data) ? data : [];
    console.log(`[SongLib] Loaded ${songs.length} song(s).`);
    if (songs.length > 0) {
      console.log(`[SongLib] IDs: ${songs.map(s => s.id).join(', ')}`);
    }
  } catch (err) {
    console.warn('[SongLib] manifest.json unavailable — song list empty.', err.message);
    songs = [];
  }
  return songs;
}

/**
 * 获取全部歌曲列表
 * @returns {Array}
 */
export function getSongs() {
  return songs;
}

/**
 * 选中一首歌
 * @param {string} id
 */
export function selectSong(id) {
  selectedId = id;
  const found = songs.find(s => s.id === id);
  console.log(`[SongLib] Selected: "${id}" → ${found ? found.title : 'NOT FOUND'}`);
}

/**
 * 获取当前选中歌曲
 * @returns {Object|null}
 */
export function getSelectedSong() {
  if (!selectedId) {
    console.warn('[SongLib] getSelectedSong: selectedId is null/empty');
    return null;
  }
  const found = songs.find(s => s.id === selectedId);
  if (!found) {
    console.warn(`[SongLib] getSelectedSong: id="${selectedId}" not found in [${songs.map(s => s.id).join(', ')}]`);
  }
  return found || null;
}
