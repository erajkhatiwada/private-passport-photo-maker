// Webcam capture. The video stream stays in this page and is stopped as soon as the
// dialog closes.
export class Camera {
  constructor(els, onCapture) {
    this.els = els; // { dialog, video, shoot, cancel, switchBtn, timer, count, error }
    this.onCapture = onCapture;
    this.stream = null;
    this.facing = 'user';
    this.countdown = 0;
    els.shoot.addEventListener('click', () => this.shoot());
    els.cancel.addEventListener('click', () => els.dialog.close());
    els.switchBtn.addEventListener('click', () => {
      this.facing = this.facing === 'user' ? 'environment' : 'user';
      this.start();
    });
    els.dialog.addEventListener('close', () => this.stop());
  }

  async open() {
    this.els.error.hidden = true;
    this.els.dialog.showModal();
    await this.start();
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.els.switchBtn.hidden = devices.filter((d) => d.kind === 'videoinput').length < 2;
    } catch {
      this.els.switchBtn.hidden = true;
    }
  }

  async start() {
    this.stopTracks();
    const { video, shoot, error } = this.els;
    shoot.disabled = true;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access needs HTTPS or localhost.');
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: this.facing, width: { ideal: 1920 }, height: { ideal: 1440 } },
      });
      if (!this.els.dialog.open) return this.stopTracks();
      video.srcObject = this.stream;
      video.classList.toggle('mirrored', this.facing === 'user');
      await video.play();
      shoot.disabled = false;
    } catch (err) {
      error.textContent =
        err?.name === 'NotAllowedError'
          ? 'Camera permission was denied. Allow camera access in your browser settings, or choose a photo instead.'
          : `Could not start the camera: ${err?.message || err}`;
      error.hidden = false;
    }
  }

  shoot() {
    if (this.countdown) return;
    if (!this.els.timer.checked) return this.capture();
    let n = 3;
    const { count } = this.els;
    count.textContent = n;
    count.hidden = false;
    this.countdown = setInterval(() => {
      n -= 1;
      if (n > 0) {
        count.textContent = n;
        return;
      }
      clearInterval(this.countdown);
      this.countdown = 0;
      count.hidden = true;
      this.capture();
    }, 1000);
  }

  capture() {
    const { video, dialog } = this.els;
    if (!video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    // Captured un-mirrored, i.e. how other people see you.
    canvas.getContext('2d').drawImage(video, 0, 0);
    dialog.close();
    this.onCapture(canvas);
  }

  stopTracks() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.els.video.srcObject = null;
  }

  stop() {
    clearInterval(this.countdown);
    this.countdown = 0;
    this.els.count.hidden = true;
    this.stopTracks();
  }
}
