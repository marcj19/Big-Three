import * as T from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { ProviderId } from '../shared/api.js';
import { ACTIVE_ACTIVITIES, OFFICE_SKINS, type OfficeStatus } from './office-model.js';
import { defaultWardrobe, ROOM_PALETTES, type Wardrobe } from './office-wardrobe.js';
import { officePose } from './office-motion.js';

interface Callbacks {
  onSelect(id: ProviderId): void;
  onPosition(id: ProviderId, x: number, y: number): void;
  onBubblePosition?(id: ProviderId, x: number, y: number): void;
  onError(): void;
  preview?: ProviderId;
}
export interface OfficeScene {
  update(statuses: Record<ProviderId, OfficeStatus>): void;
  select(id: ProviderId): void;
  resetCamera(): void;
  setReducedMotion(reduced: boolean): void;
  setWardrobe(wardrobe: Wardrobe): void;
  setPaused(paused: boolean): void;
  dispose(): void;
}
interface Character {
  id: ProviderId;
  root: T.Group;
  head: T.Group;
  eyes: T.Mesh[];
  hands: T.Mesh[];
  screen: T.Mesh<T.BoxGeometry, T.MeshStandardMaterial>;
  ring: T.Mesh<T.TorusGeometry, T.MeshBasicMaterial>;
  status: OfficeStatus;
  x: number;
  changedAt: number;
  clothes: T.Group;
  hats: T.Group;
  accessories: T.Group;
  book: T.Group;
  pencil: T.Group;
  database: T.Group;
}

/** Local procedural geometry: no model downloads, remote textures, or model calls. */
export function createOfficeScene(host: HTMLElement, callbacks: Callbacks): OfficeScene {
  const renderer = new T.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFShadowMap;
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.domElement.setAttribute('aria-hidden', 'true');
  host.prepend(renderer.domElement);
  const scene = new T.Scene();
  const camera = new T.OrthographicCamera(-8, 8, 6, -6, .1, 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enablePan = false;
  controls.minZoom = .75;
  controls.maxZoom = 1.8;
  controls.minPolarAngle = .35;
  controls.maxPolarAngle = 1.25;
  controls.minAzimuthAngle = -.8;
  controls.maxAzimuthAngle = 1.15;
  controls.target.set(0, 1, 0);
  const home = () => { if (callbacks.preview) camera.position.set(3, 2.5, 6); else camera.position.set(9, 8, 14); camera.zoom = 1;
    controls.target.set(0, callbacks.preview ? 1.4 : 1, 0); camera.updateProjectionMatrix(); controls.update(); draw(performance.now()); };
  const hemi = new T.HemisphereLight('#ffefdc', '#788c99', 2.4);
  scene.add(hemi);
  const sun = new T.DirectionalLight('#fff1d9', 2.6);
  sun.position.set(-3, 9, 5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8 });
  sun.shadow.normalBias = .03;
  scene.add(sun);

  const mat = (color: string) => new T.MeshToonMaterial({ color });
  const cream = mat('#f6ead9'), wood = mat('#c69e7e'), white = mat('#fffbef');
  const ink = mat('#293947'), mint = mat('#8fb5a0'), leaf = mat('#568c70');
  const room = new T.Group(); scene.add(room); room.visible = !callbacks.preview;
  function mesh(geometry: T.BufferGeometry, material: T.Material, parent: T.Object3D, x: number, y: number, z: number): T.Mesh {
    const item = new T.Mesh(geometry, material);
    item.position.set(x, y, z);
    item.castShadow = true;
    item.receiveShadow = true;
    parent.add(item);
    return item;
  }
  function box(parent: T.Object3D, material: T.Material, x: number, y: number, z: number, w: number, h: number, d: number, round = .06): T.Mesh {
    return mesh(new RoundedBoxGeometry(w, h, d, 2, Math.min(round, w / 3, h / 3, d / 3)), material, parent, x, y, z);
  }
  function ball(parent: T.Object3D, material: T.Material, x: number, y: number, z: number, radius: number): T.Mesh {
    return mesh(new T.SphereGeometry(radius, 20, 12), material, parent, x, y, z);
  }
  box(room, mint, 0, -.22, 0, 13.4, .4, 8.6, .15);
  box(room, cream, 0, 1.65, -4.15, 13.4, 3.7, .2);
  box(room, cream, -6.6, 1.65, 0, .2, 3.7, 8.3);
  // Floorboards and a soft carpet keep the room readable from the isometric camera.
  for (let x = -6.1; x < 6.5; x += .8) box(room, mat('#89a994'), x, -.012, .05, .012, .012, 8.1, 0);
  const rug = mat('#d6d5bd');
  box(room, rug, 0, .008, .35, 11.5, .04, 4.7, .02);
  const glass = new T.MeshBasicMaterial({ color: '#bde5ed' });
  for (const x of [-3.4, -.9]) {
    box(room, white, x - .7, 2.15, -3.98, 2.1, 2.05, .12);
    box(room, glass, x - .7, 2.15, -3.89, 1.88, 1.84, .03);
    box(room, white, x - .7, 2.15, -3.84, .055, 1.9, .05);
    box(room, white, x - .7, 2.15, -3.84, 1.9, .055, .05);
    box(room, wood, x - .7, 1.13, -3.7, 2.35, .12, .5);
  }
  // Pin board with tiny original notes, and a wall clock.
  box(room, wood, 3, 2.15, -3.96, 2.8, 1.6, .12);
  box(room, mat('#9aaf9d'), 3, 2.15, -3.87, 2.6, 1.4, .04);
  for (let i = 0; i < 6; i++) {
    const note = box(room, mat(['#f5cd85', '#c7d6ef', '#f2b7a5'][i % 3]!), 2.25 + (i % 3) * .7, 2.48 - Math.floor(i / 3) * .57, -3.8, .4, .4, .02);
    note.rotation.z = (i % 2 ? 1 : -1) * .08;
  }
  const clock = mesh(new T.CylinderGeometry(.39, .39, .1, 32), white, room, -6.42, 2.7, -.9);
  clock.rotation.z = Math.PI / 2;
  box(room, ink, -6.35, 2.79, -.9, .04, .18, .025);
  box(room, ink, -6.34, 2.7, -.81, .04, .025, .2);
  function plant(x: number, z: number, scale = 1): void {
    const group = new T.Group(); group.position.set(x, 0, z); group.scale.setScalar(scale); room.add(group);
    mesh(new T.CylinderGeometry(.32, .23, .5, 16), mat('#e7b38f'), group, 0, .25, 0);
    for (let i = 0; i < 7; i++) {
      const angle = i * 2.4;
      const l = ball(group, leaf, Math.cos(angle) * .21, .8 + i % 3 * .16, Math.sin(angle) * .21, .28);
      l.scale.set(.5, 1.7, .7); l.rotation.z = Math.cos(angle) * .6;
    }
  }
  plant(-5.5, -3.1, 1.5); plant(5.7, -3.1, 1.6); plant(5.8, 3.3, .9);
  // Low shelf, books, and a coffee corner.
  box(room, wood, 1.1, .53, -3.4, 3.1, 1.05, .7);
  box(room, cream, 1.1, .58, -3.01, 2.9, .67, .04);
  for (let i = 0; i < 7; i++) box(room, mat(['#738ca7', '#e5b26f', '#a3b79e'][i % 3]!), .15 + i * .24, .64, -2.95, .15, .51 - (i % 2) * .1, .27);
  box(room, ink, 1.9, 1.35, -3.4, .45, .55, .38);
  mesh(new T.CylinderGeometry(.13, .13, .2, 16), white, room, 1.2, 1.16, -3.33);
  // A little lounge in the newly opened floor space.
  box(room, mat('#aebc9c'), -4.7, .46, 2.7, 2.1, .65, .92, .2);
  box(room, mat('#94a585'), -4.7, .95, 2.37, 2.1, .7, .24, .1);
  for (const x of [-5.6, -3.8]) box(room, wood, x, .2, 2.75, .12, .4, .12);
  mesh(new T.CylinderGeometry(.57, .57, .1, 32), wood, room, -2.7, .67, 2.9);
  box(room, ink, -2.7, .32, 2.9, .1, .6, .1);
  mesh(new T.CylinderGeometry(.09, .075, .18, 16), white, room, -2.7, .81, 2.9);

  const characters: Character[] = [];
  for (const [index, id] of (['claude', 'gemini', 'codex'] as const).entries()) {
    if (callbacks.preview && callbacks.preview !== id) continue;
    const x = callbacks.preview ? 0 : (index - 1) * 3.65;
    const skin = OFFICE_SKINS.classic[id];
    const color = mat(skin.color), accent = mat(skin.accent);
    const station = new T.Group(); station.position.x = x; scene.add(station);
    const furniture = new T.Group(); station.add(furniture); furniture.visible = !callbacks.preview;
    // Each character sits behind a desk, facing the viewer and their screen.
    box(furniture, wood, 0, 1.02, .7, 2.45, .16, 1.25);
    for (const lx of [-.98, .98]) for (const lz of [.25, 1.15]) box(furniture, cream, lx, .5, lz, .1, 1, .1);
    box(furniture, ink, 0, 1.35, .6, .1, .55, .08);
    box(furniture, ink, 0, 1.62, .6, 1.07, .69, .1);
    const screenMat = new T.MeshStandardMaterial({ color: skin.accent, emissive: skin.color, emissiveIntensity: .18, roughness: .8 });
    const screen = new T.Mesh(new T.BoxGeometry(.92, .53, .015), screenMat);
    screen.position.set(0, 1.62, .66); furniture.add(screen);
    for (let line = 0; line < 3; line++) box(furniture, color, -.13 + (line % 2) * .07, 1.76 - line * .13, .68, .48 - (line % 2) * .15, .035, .012);
    box(furniture, cream, 0, 1.13, 1.05, .85, .055, .23);
    mesh(new T.CylinderGeometry(.1, .085, .22, 16), accent, furniture, .85, 1.2, .95);
    // Chair.
    box(furniture, ink, 0, .64, -.62, .86, .18, .75);
    box(furniture, ink, 0, 1.03, -.94, .87, .85, .14);
    box(furniture, ink, 0, .29, -.62, .1, .6, .1);
    const root = new T.Group(); root.position.set(0, .76, -.43); station.add(root);
    box(root, color, 0, .35, 0, .68, .7, .5, .18);
    for (const side of [-1, 1]) {
      box(root, accent, side * .21, -.05, .24, .24, .26, .5, .08);
      box(root, ink, side * .21, -.19, .4, .26, .17, .35, .07);
    }
    const head = new T.Group(); head.position.y = 1.03; root.add(head);
    if (skin.shape === 'bot') {
      box(head, color, 0, 0, 0, 1.05, .83, .72, .22);
      box(head, ink, 0, -.02, .37, .82, .46, .04, .12);
      box(head, color, 0, .53, 0, .07, .28, .07);
      ball(head, accent, 0, .71, 0, .11);
      for (const side of [-1, 1]) ball(head, accent, side * .56, 0, 0, .15);
    } else if (skin.shape === 'sun') {
      ball(head, color, 0, 0, 0, .55);
      for (let i = 0; i < 9; i++) {
        const a = i / 9 * Math.PI * 2;
        const ray = box(head, color, Math.sin(a) * .56, Math.cos(a) * .56, -.08, .18, .38, .27, .08);
        ray.rotation.z = -a;
      }
    } else {
      ball(head, color, 0, 0, 0, .51);
      for (let i = 0; i < 4; i++) {
        const a = i / 4 * Math.PI * 2;
        const point = mesh(new T.ConeGeometry(.26, .55, 4), i % 2 ? accent : color, head, Math.sin(a) * .49, Math.cos(a) * .49, -.03);
        point.rotation.z = -a;
      }
    }
    const eyes = [-1, 1].map((side) => {
      const eye = ball(head, skin.shape === 'bot' ? accent : ink, side * .19, .04, skin.shape === 'bot' ? .407 : .48, .065);
      eye.scale.set(.8, 1.35, .55); return eye;
    });
    const smile = mesh(new T.TorusGeometry(.1, .018, 6, 16, Math.PI), skin.shape === 'bot' ? accent : ink, head, 0, -.12, .505);
    smile.rotation.z = Math.PI;
    const hands = [-1, 1].map((side) => ball(root, accent, side * .48, .28, .44, .15));
    const clothes = new T.Group(), hats = new T.Group(), accessories = new T.Group();
    root.add(clothes); head.add(hats, accessories);
    const book = new T.Group(); root.add(book);
    box(book, mat('#627f9a'), 0, .53, .72, .72, .38, .08);
    for (const side of [-1, 1]) {
      const page = box(book, white, side * .17, .55, .78, .31, .29, .025);
      page.rotation.y = side * -.12;
      for (let line = 0; line < 3; line++) box(book, mint, side * .17, .63 - line * .075, .8, .21, .015, .012, 0);
    }
    const pencil = new T.Group(); root.add(pencil);
    const pen = mesh(new T.CylinderGeometry(.025, .025, .4, 8), mat('#edb95f'), pencil, .48, .52, .68);
    pen.rotation.z = -.35;
    box(pencil, white, .25, .25, .71, .38, .05, .38);
    const database = new T.Group(); root.add(database);
    for (let row = 0; row < 3; row++) mesh(new T.CylinderGeometry(.16, .16, .12, 20), row % 2 ? mint : accent, database, .78, .36 + row * .15, .45);
    const ring = new T.Mesh(new T.TorusGeometry(.73, .035, 6, 48), new T.MeshBasicMaterial({ color: skin.color }));
    ring.rotation.x = -Math.PI / 2; ring.position.set(x, .06, -.45); scene.add(ring);
    root.traverse((obj) => { obj.userData.provider = id; });
    characters.push({ id, root, head, eyes, hands, screen, ring, x, status: 'idle', changedAt: 0, clothes, hats, accessories, book, pencil, database });
  }

  let disposed = false, reduced = false, intersecting = true, paused = false;
  let wardrobe = defaultWardrobe();
  function clearCosmetics(group: T.Group): void {
    const materials = new Set<T.Material>();
    group.traverse((obj) => { if (obj instanceof T.Mesh) {
      obj.geometry.dispose();
      for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) if (m.userData.cosmetic) materials.add(m);
    } });
    for (const material of materials) material.dispose();
    group.clear();
  }
  function cosmeticMaterial(color: string) { const m = mat(color); m.userData.cosmetic = true; return m; }
  function dress(value: Wardrobe): void {
    wardrobe = value;
    const palette = ROOM_PALETTES[value.room];
    mint.color.set(palette.floor); cream.color.set(palette.wall); rug.color.set(palette.rug);
    for (const c of characters) {
      for (const group of [c.clothes, c.hats, c.accessories]) clearCosmetics(group);
      const look = value.looks[c.id];
      if (look.outfit !== 'classic') {
        const outfit = cosmeticMaterial(look.outfit === 'hoodie' ? '#718eac' : look.outfit === 'blazer' ? '#525b7b' : '#e6dfd0');
        box(c.clothes, outfit, 0, .34, .02, .74, .73, .55, .16);
        if (look.outfit === 'hoodie') {
          box(c.clothes, outfit, 0, .18, .32, .4, .18, .04);
          for (const side of [-1, 1]) box(c.clothes, white, side * .13, .52, .32, .025, .17, .02);
        } else if (look.outfit === 'blazer') {
          box(c.clothes, white, 0, .44, .32, .23, .48, .03);
          for (const side of [-1, 1]) { const lapel = box(c.clothes, outfit, side * .17, .51, .35, .15, .37, .04); lapel.rotation.z = side * -.25; }
          box(c.clothes, cosmeticMaterial('#c8866d'), 0, .5, .36, .06, .24, .025);
        } else {
          box(c.clothes, ink, 0, .15, .32, .69, .08, .025);
          box(c.clothes, cosmeticMaterial('#91b5ce'), 0, .47, .33, .36, .22, .04);
          box(c.clothes, outfit, 0, .38, -.4, .58, .6, .26);
          for (const side of [-1, 1]) mesh(new T.CylinderGeometry(.09, .09, .57, 12), white, c.clothes, side * .3, .36, -.4);
        }
      }
      if (look.hat === 'beanie') {
        const fabric = cosmeticMaterial('#c77869');
        const cap = ball(c.hats, fabric, 0, .5, -.02, .48); cap.scale.set(1, .65, 1);
        mesh(new T.TorusGeometry(.44, .065, 8, 28), fabric, c.hats, 0, .43, -.02).rotation.x = Math.PI / 2;
        ball(c.hats, white, 0, .84, -.02, .12);
      } else if (look.hat === 'cap') {
        const fabric = cosmeticMaterial('#83a18b');
        const cap = ball(c.hats, fabric, 0, .48, -.04, .46); cap.scale.y = .55;
        box(c.hats, fabric, .07, .44, .45, .68, .07, .45, .02);
      } else if (look.hat === 'sprout') {
        box(c.hats, leaf, 0, .79, 0, .055, .44, .055);
        for (const side of [-1, 1]) { const l = ball(c.hats, leaf, side * .16, .93, 0, .18); l.scale.set(1.5, .45, .6); l.rotation.z = side * .35; }
      }
      if (look.accessory === 'glasses') {
        const frames = cosmeticMaterial('#475566');
        for (const side of [-1, 1]) mesh(new T.TorusGeometry(.15, .023, 8, 24), frames, c.accessories, side * .2, .045, .55);
        box(c.accessories, frames, 0, .06, .55, .1, .025, .025);
      } else if (look.accessory === 'headphones') {
        const fabric = cosmeticMaterial('#ad92b9');
        mesh(new T.TorusGeometry(.59, .055, 8, 32, Math.PI), fabric, c.accessories, 0, .06, -.06);
        for (const side of [-1, 1]) box(c.accessories, fabric, side * .58, .01, -.03, .17, .36, .3, .08);
      }
      c.root.traverse((obj) => { obj.userData.provider = c.id; });
    }
    draw(performance.now());
  }
  let lastFrame = 0;
  function draw(time: number): void {
    if (disposed) return;
    const t = reduced ? 1 : time / 1000;
    for (const [i, c] of characters.entries()) {
      const active = ACTIVE_ACTIVITIES.includes(c.status);
      const unavailable = ['offline', 'signed-out', 'checking', 'away'].includes(c.status);
      const index = ['claude', 'gemini', 'codex'].indexOf(c.id);
      const pose = officePose(c.status, t, index, wardrobe.pace === 'calm', reduced ? 10 : Math.max(0, (time - c.changedAt) / 1000));
      c.head.rotation.set(0, pose.headY, pose.headZ);
      c.root.position.y = .76 + (reduced ? 0 : pose.bodyY);
      c.hands[0]!.position.set(-.48, pose.leftY, pose.leftZ);
      c.hands[1]!.position.set(.48, pose.rightY, pose.rightZ);
      c.eyes.forEach((eye) => { eye.scale.y = !reduced && pose.blink ? .15 : 1.35; });
      c.book.visible = pose.book; c.pencil.visible = pose.pencil; c.database.visible = pose.database;
      c.screen.material.color.set(pose.terminal ? '#27453e' : pose.database ? '#aecadc' : OFFICE_SKINS.classic[c.id].accent);
      c.screen.material.emissiveIntensity = active ? .45 : unavailable ? .02 : .12;
      c.root.rotation.x = unavailable ? -.08 : 0;
      const point = new T.Vector3(c.x, .05, 1.65).project(camera);
      callbacks.onPosition(c.id, (point.x + 1) * 50, (1 - point.y) * 50);
      const bubble = new T.Vector3(c.x, 2.95, -.4).project(camera);
      callbacks.onBubblePosition?.(c.id, (bubble.x + 1) * 50, (1 - bubble.y) * 50);
    }
    renderer.render(scene, camera);
  }
  function loop(time: number): void { if (time - lastFrame >= 1000 / 30) { lastFrame = time; draw(time); } }
  function playback(): void {
    if (disposed) return;
    renderer.setAnimationLoop(!reduced && !paused && !document.hidden && intersecting ? loop : null);
    if (!document.hidden && intersecting) draw(performance.now());
  }
  const resize = new ResizeObserver(() => {
    const { width, height } = host.getBoundingClientRect();
    if (!width || !height) return;
    const aspect = width / height;
    const viewHeight = callbacks.preview ? Math.max(3.1, 2.6 / aspect) : Math.max(8.2, 16.4 / aspect);
    camera.left = -viewHeight * aspect / 2; camera.right = -camera.left;
    camera.top = viewHeight / 2; camera.bottom = -camera.top;
    camera.updateProjectionMatrix(); renderer.setSize(width, height); draw(performance.now());
  });
  resize.observe(host);
  const visibility = new IntersectionObserver(([entry]) => { intersecting = entry?.isIntersecting ?? false; playback(); });
  visibility.observe(host);
  document.addEventListener('visibilitychange', playback);
  const change = () => draw(performance.now());
  controls.addEventListener('change', change);
  let down = { x: 0, y: 0 };
  const pointerDown = (event: PointerEvent) => { down = { x: event.clientX, y: event.clientY }; };
  const pointerUp = (event: PointerEvent) => {
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const ray = new T.Raycaster();
    ray.setFromCamera(new T.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), camera);
    const hit = ray.intersectObjects(characters.map((c) => c.root), true)[0];
    if (hit) callbacks.onSelect(hit.object.userData.provider as ProviderId);
  };
  const lost = (event: Event) => { event.preventDefault(); callbacks.onError(); };
  renderer.domElement.addEventListener('pointerdown', pointerDown);
  renderer.domElement.addEventListener('pointerup', pointerUp);
  renderer.domElement.addEventListener('webglcontextlost', lost);
  home(); dress(wardrobe); playback();
  return {
    update(statuses) { for (const c of characters) { if (c.status !== statuses[c.id]) c.changedAt = performance.now(); c.status = statuses[c.id]; } draw(performance.now()); },
    select(id) { for (const c of characters) c.ring.visible = c.id === id; draw(performance.now()); },
    resetCamera: home,
    setReducedMotion(value) { reduced = value; playback(); },
    setWardrobe: dress,
    setPaused(value) { paused = value; playback(); },
    dispose() {
      if (disposed) return;
      disposed = true; renderer.setAnimationLoop(null);
      resize.disconnect(); visibility.disconnect(); controls.dispose();
      document.removeEventListener('visibilitychange', playback);
      renderer.domElement.removeEventListener('pointerdown', pointerDown);
      renderer.domElement.removeEventListener('pointerup', pointerUp);
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      const geometries = new Set<T.BufferGeometry>(), materials = new Set<T.Material>();
      scene.traverse((obj) => {
        if (obj instanceof T.Mesh) {
          geometries.add(obj.geometry);
          for (const material of Array.isArray(obj.material) ? obj.material : [obj.material]) materials.add(material);
        }
      });
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      sun.shadow.dispose(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    },
  };
}
