let connection = null;
const DATABASE = 'still-camera-gallery';

function database() {
  if (connection) return connection;
  connection = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('This browser does not allow local photo storage.'));
      return;
    }
    const request = indexedDB.open(DATABASE, 1);
    let abandoned = false;
    const timeout = setTimeout(() => {
      abandoned = true;
      reject(new Error('Local photo storage did not respond. Close other Still windows, then retry.'));
    }, 15000);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('photos', { keyPath: 'id' });
      const entries = db.createObjectStore('entries', { keyPath: 'id' });
      entries.createIndex('createdAt', 'createdAt');
    };
    request.onerror = () => {
      clearTimeout(timeout);
      reject(request.error);
    };
    request.onblocked = () => {
      clearTimeout(timeout);
      abandoned = true;
      reject(new Error('Close other Still windows and reopen the gallery.'));
    };
    request.onsuccess = () => {
      const db = request.result;
      clearTimeout(timeout);
      if (abandoned) {
        db.close();
        return;
      }
      db.onversionchange = () => {
        db.close();
        connection = null;
      };
      db.onclose = () => { connection = null; };
      resolve(db);
    };
  });
  // Reset the connection for retries. Callers still receive the original rejection.
  connection.catch(() => { connection = null; });
  return connection;
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error('Local photo storage was interrupted.'));
    transaction.onerror = () => reject(transaction.error || new Error('Local photo storage failed.'));
  });
}

function writeTransaction(db, write) {
  const transaction = db.transaction(['photos', 'entries'], 'readwrite');
  return new Promise((resolve, reject) => {
    let writeError = null;
    const failed = () => reject(writeError || transaction.error || new Error('Local photo storage was interrupted.'));
    transaction.oncomplete = () => resolve();
    transaction.onabort = failed;
    transaction.onerror = failed;
    try {
      write(transaction);
    } catch (cause) {
      writeError = cause;
      transaction.abort();
    }
  });
}

export async function savePhoto(photo, thumbnail) {
  if (!photo.id || !(photo.blob instanceof Blob) || !(thumbnail instanceof Blob)) {
    throw new Error('A photo and thumbnail are required for the gallery.');
  }
  const db = await database();
  const { blob, ...metadata } = photo;
  await writeTransaction(db, transaction => {
    transaction.objectStore('photos').put(photo);
    transaction.objectStore('entries').put({ ...metadata, thumbnail });
  });
}

export async function listPhotos(limit = 12) {
  const db = await database();
  const transaction = db.transaction('entries', 'readonly');
  const completed = transactionDone(transaction);
  const entries = [];
  const store = transaction.objectStore('entries');
  const count = store.count();
  const cursor = store.index('createdAt').openCursor(null, 'prev');
  cursor.onsuccess = () => {
    const item = cursor.result;
    if (item && entries.length < limit) {
      entries.push(item.value);
      item.continue();
    }
  };
  await completed;
  return { entries, total: count.result };
}

export async function getPhoto(id) {
  const db = await database();
  const transaction = db.transaction('photos', 'readonly');
  const completed = transactionDone(transaction);
  const request = transaction.objectStore('photos').get(id);
  await completed;
  if (!request.result) throw new Error('This photo is no longer in the local gallery.');
  return request.result;
}

export async function deletePhoto(id) {
  const db = await database();
  await writeTransaction(db, transaction => {
    transaction.objectStore('photos').delete(id);
    transaction.objectStore('entries').delete(id);
  });
}

export async function makeThumbnail(blob) {
  const url = URL.createObjectURL(blob);
  const image = new Image();
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('The gallery thumbnail could not be created.'));
      image.src = url;
    });
    const scale = Math.min(1, 240 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('The gallery thumbnail renderer is unavailable.');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => {
      canvas.toBlob(result => result ? resolve(result) : reject(new Error('The gallery thumbnail could not be encoded.')), 'image/jpeg', 0.8);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
