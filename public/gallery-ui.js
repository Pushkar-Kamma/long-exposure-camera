import { deletePhoto, getPhoto, listPhotos } from './gallery.js';

const $ = id => document.getElementById(id);

export class LocalGallery {
  constructor(onDelete) {
    this.onDelete = onDelete;
    this.limit = 12;
    this.urls = [];
    this.latestURL = null;
    this.selectedURL = null;
    this.selected = null;
    this.selectedFile = null;
    this.loadGeneration = 0;
    this.viewGeneration = 0;
    $('galleryClose').addEventListener('click', () => $('galleryDialog').close());
    $('galleryDialog').addEventListener('close', () => {
      this.clearSelected();
      this.clearThumbnails();
      $('galleryGrid').replaceChildren();
      this.loadGeneration++;
    });
    $('galleryBack').addEventListener('click', () => this.showGrid());
    $('galleryMore').addEventListener('click', () => {
      this.limit += 12;
      void this.refresh();
    });
    $('galleryRetry').addEventListener('click', () => { void this.refresh(); });
    $('galleryShare').addEventListener('click', () => { void this.share(); });
    $('galleryDelete').addEventListener('click', () => { void this.remove(); });
  }

  status(text, failed = false) {
    $('galleryStatus').textContent = text;
    $('galleryStatus').dataset.error = String(failed);
  }

  async open() {
    this.limit = 12;
    this.showGrid();
    $('galleryDialog').showModal();
    await this.refresh();
  }

  clearThumbnails() {
    this.urls.forEach(url => URL.revokeObjectURL(url));
    this.urls = [];
  }

  clearSelected() {
    this.viewGeneration++;
    this.selected = null;
    this.selectedFile = null;
    if (this.selectedURL) URL.revokeObjectURL(this.selectedURL);
    this.selectedURL = null;
    $('galleryImage').removeAttribute('src');
    $('galleryDownload').removeAttribute('href');
    $('galleryShare').disabled = true;
  }

  showGrid() {
    this.clearSelected();
    $('galleryViewer').hidden = true;
    $('galleryGrid').hidden = false;
    $('galleryMore').hidden = this.total <= this.limit || !this.total;
  }

  async refresh() {
    const generation = ++this.loadGeneration;
    $('galleryRetry').hidden = true;
    try {
      const { entries, total } = await listPhotos(this.limit);
      if (generation !== this.loadGeneration) return;
      this.total = total;
      $('galleryCount').textContent = String(total);
      if (this.latestURL) URL.revokeObjectURL(this.latestURL);
      this.latestURL = entries.length ? URL.createObjectURL(entries[0].thumbnail) : null;
      $('latestThumbnail').hidden = !this.latestURL;
      if (this.latestURL) $('latestThumbnail').src = this.latestURL;
      else $('latestThumbnail').removeAttribute('src');
      this.clearThumbnails();
      $('galleryGrid').replaceChildren();
      if ($('galleryDialog').open) {
        entries.forEach(entry => {
          const button = document.createElement('button');
          button.className = 'gallery-card';
          button.type = 'button';
          button.dataset.photoId = entry.id;
          const image = new Image();
          image.alt = `${entry.actual.toFixed(1)} second ${entry.mode === 'trails' ? 'light trail' : 'smooth motion'} exposure`;
          image.loading = 'lazy';
          const url = URL.createObjectURL(entry.thumbnail);
          this.urls.push(url);
          image.src = url;
          const label = document.createElement('span');
          label.textContent = `${entry.actual.toFixed(1)}s / ${entry.outcome === 'complete' ? 'Complete' : 'Partial'}`;
          button.append(image, label);
          button.addEventListener('click', () => { void this.view(entry.id); });
          $('galleryGrid').append(button);
        });
      }
      $('galleryMore').hidden = total <= this.limit || Boolean(this.selected);
      this.status(total ? `${total} ${total === 1 ? 'photo' : 'photos'} stored on this device.` : 'No photos yet. Completed exposures will appear here automatically.');
    } catch (cause) {
      this.status(`Gallery unavailable: ${cause.message} Save current photos using Save / Share or Download JPEG.`, true);
      $('galleryRetry').hidden = false;
      $('galleryCount').textContent = '!';
    }
  }

  async view(id) {
    this.clearSelected();
    const generation = this.viewGeneration;
    this.status('Opening photo...');
    try {
      const photo = await getPhoto(id);
      if (generation !== this.viewGeneration || !$('galleryDialog').open) return;
      this.selected = photo;
      this.selectedFile = new File([photo.blob], photo.name, { type: photo.blob.type });
      this.selectedURL = URL.createObjectURL(photo.blob);
      $('galleryImage').src = this.selectedURL;
      $('galleryDownload').href = this.selectedURL;
      $('galleryDownload').download = photo.name;
      $('galleryDetails').textContent = `${new Date(photo.createdAt).toLocaleString()} / ${photo.actual.toFixed(1)}s of ${photo.requested}s / ${photo.width} x ${photo.height} / ${photo.mode === 'trails' ? 'Light trails' : 'Smooth motion'}${photo.outcome === 'complete' ? '' : ' / Partial exposure'}`;
      $('galleryShare').disabled = false;
      $('galleryGrid').hidden = true;
      $('galleryMore').hidden = true;
      $('galleryViewer').hidden = false;
      this.status('Save to Photos or Files to keep a copy outside this browser.');
    } catch (cause) {
      this.status(`Could not open this photo: ${cause.message}`, true);
    }
  }

  async share() {
    if (!this.selected) {
      this.status('Choose a photo before sharing.', true);
      return;
    }
    try {
      if (navigator.canShare?.({ files: [this.selectedFile] })) {
        await navigator.share({ files: [this.selectedFile] });
      } else {
        $('galleryDownload').click();
        this.status('Open the downloaded JPEG to save it to Photos or Files.');
      }
    } catch (cause) {
      if (cause.name !== 'AbortError') this.status(`Sharing failed: ${cause.message}. Use Download JPEG instead.`, true);
    }
  }

  async remove() {
    if (!this.selected) {
      this.status('Choose a photo before deleting.', true);
      return;
    }
    if (!window.confirm('Delete this photo from the local gallery? This cannot be undone. Copies already saved to Photos or Files are not affected.')) return;
    const id = this.selected.id;
    $('galleryDelete').disabled = true;
    try {
      await deletePhoto(id);
      this.onDelete(id);
      this.showGrid();
      await this.refresh();
    } catch (cause) {
      this.status(`The photo could not be deleted: ${cause.message}`, true);
    } finally {
      $('galleryDelete').disabled = false;
    }
  }
}
