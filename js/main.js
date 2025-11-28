const Playlist = {
    el: document.getElementById('playlist-ui'),
    dragIdx: null,

    init() {
        bus.on('state-changed', () => this.render());
        this.el.addEventListener('dragstart', (e) => {
            if (e.target.tagName === 'LI') {
                this.dragIdx = +e.target.dataset.index;
                e.target.classList.add('dragging');
            }
        });
        this.el.addEventListener('dragover', e => e.preventDefault());
        this.el.addEventListener('drop', (e) => {
            e.preventDefault();
            const li = e.target.closest('li');
            if (li && this.dragIdx !== null) {
                bus.emit('seek'); // 停止播放
                Store.reorderClips(this.dragIdx, +li.dataset.index);
            }
            document.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
            this.dragIdx = null;
        });
    },

    render() {
        this.el.innerHTML = '';
        Store.getClips().forEach((clip, i) => {
            const li = document.createElement('li');
            li.className = 'playlist-item';
            li.draggable = true;
            li.dataset.index = i;
            
            // 修改：增加 裁剪 按钮
            li.innerHTML = `
                <span>${i+1}. ${clip.name}</span>
                <span style="color:#999; font-size:10px;">${Utils.formatTime(clip.duration)}</span>
                <div style="display:flex; gap:5px; margin-top:5px;">
                    <button class="btn sm" onclick="openTrimModal(${clip.id})">裁剪</button>
                    <button class="btn danger sm" onclick="Playlist.del(${clip.id})">删除</button>
                </div>
            `;
            this.el.appendChild(li);
        });
    },
    
    del(id) { bus.emit('seek'); Store.removeClip(id); }
};

const Timeline = {
    canvas: document.getElementById('timeline-canvas'),
    ctx: document.getElementById('timeline-canvas').getContext('2d'),
    wrapper: document.getElementById('timeline-wrapper'),
    playhead: document.getElementById('playhead'),
    pxPerSec: 30,
    hoverX: null, // 记录悬浮位置

    init() {
        this.resize();
        window.addEventListener('resize', () => this.resize());
        bus.on('state-changed', () => this.resize());
        bus.on('time-updated', (t) => this.updatePlayhead(t));

        // 点击 Seek
        this.canvas.addEventListener('click', (e) => {
            const t = e.offsetX / this.pxPerSec;
            bus.emit('seek');
            Store.setCurrentTime(t);
        });

        // 鼠标悬浮监听
        this.canvas.addEventListener('mousemove', (e) => {
            this.hoverX = e.offsetX;
            this.draw();
        });
        this.canvas.addEventListener('mouseleave', () => {
            this.hoverX = null;
            this.draw();
        });
    },

    resize() {
        const minW = this.wrapper.clientWidth;
        const contentW = Store.state.totalDuration * this.pxPerSec;
        this.canvas.width = Math.max(minW, contentW + 200);
        this.canvas.height = 100;
        this.draw();
    },

    draw() {
        const { width: w, height: h } = this.canvas;
        const ctx = this.ctx;
        ctx.clearRect(0, 0, w, h);
        
        // 背景
        ctx.fillStyle = '#222'; ctx.fillRect(0, 0, w, h);

        // 刻度设置
        ctx.strokeStyle = '#999'; ctx.fillStyle = '#999';
        ctx.font = '10px Arial'; ctx.lineWidth = 1;
        ctx.textAlign = 'center'; // 文本水平居中对齐

        const totalSec = Math.ceil(w / this.pxPerSec);
        ctx.beginPath();
        for (let s = 0; s <= totalSec; s += 0.5) {
            const x = s * this.pxPerSec;
            let tickH = 8;
            if (s % 1 === 0) {
                tickH = 16;
                // 绘制时间：MM:SS
                ctx.fillText(Utils.formatTime(s, false), x, h - 20);
            }
            if (s % 60 === 0) tickH = 24;
            ctx.moveTo(x, h); ctx.lineTo(x, h - tickH);
        }
        ctx.stroke();

        // 音频块
        let cursor = 0;
        Store.state.clips.forEach((clip, i) => {
            const x = cursor * this.pxPerSec;
            const wid = clip.duration * this.pxPerSec;
            ctx.fillStyle = i%2 ? 'rgba(0,122,204,0.1)' : 'rgba(0,122,204,0.3)';
            ctx.fillRect(x, 0, wid, h - 30);
            ctx.fillStyle = '#fff'; ctx.textAlign = 'left';
            ctx.fillText(clip.name, x + 5, 20);
            ctx.strokeStyle = '#000'; ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h-30); ctx.stroke();
            cursor += clip.duration;
        });

        // 悬浮提示
        if (this.hoverX !== null) {
            const t = this.hoverX / this.pxPerSec;
            const str = Utils.formatTime(t, false); // 悬浮显示 MM:SS
            
            ctx.save();
            ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.setLineDash([4,4]);
            ctx.beginPath(); ctx.moveTo(this.hoverX, 0); ctx.lineTo(this.hoverX, h); ctx.stroke();
            
            const txtW = ctx.measureText(str).width + 10;
            ctx.fillStyle = '#333'; ctx.fillRect(this.hoverX + 5, 5, txtW, 16);
            ctx.fillStyle = '#fff'; ctx.textAlign = 'left';
            ctx.fillText(str, this.hoverX + 10, 17);
            ctx.restore();
        }
    },

    updatePlayhead(t) {
        const x = t * this.pxPerSec;
        this.playhead.style.transform = `translateX(${x}px)`;
        // 简单跟随
        if (x > this.wrapper.scrollLeft + this.wrapper.clientWidth - 50) {
            this.wrapper.scrollLeft = x - 100;
        }
    }
};

const AudioCore = {
    ctx: new (window.AudioContext || window.webkitAudioContext)(),
    sourceNode: null, startTime: 0, startOffset: 0, scheduledNodes: [],

    init() {
        bus.on('toggle-play', () => this.toggle());
        bus.on('seek', () => this.stop());
    },
    async load(file) {
        const ab = await file.arrayBuffer();
        return await this.ctx.decodeAudioData(ab);
    },
    play() {
        if (Store.state.isPlaying || Store.state.clips.length === 0) return;
        if (this.ctx.state === 'suspended') this.ctx.resume();

        this.startTime = this.ctx.currentTime;
        this.startOffset = Store.state.currentTime;
        let cursor = 0;
        this.scheduledNodes = [];

        Store.state.clips.forEach(clip => {
            const end = cursor + clip.duration; // 注意：这里的 clip.duration 已经是裁剪后的时长
            
            if (end > this.startOffset) {
                const src = this.ctx.createBufferSource();
                src.buffer = clip.buffer;
                src.connect(this.ctx.destination);
                
                let when = 0, offsetInPlay = 0, dur = clip.duration;

                if (cursor < this.startOffset) {
                    // 从片段中间开始播放
                    offsetInPlay = this.startOffset - cursor;
                    dur -= offsetInPlay;
                } else {
                    // 片段还没开始，等待播放
                    when = cursor - this.startOffset;
                }

                // 核心修改：实际读取 Buffer 的偏移量 = 裁剪开始点 + 当前播放进度偏移
                const bufferOffset = clip.trimStart + offsetInPlay;

                src.start(this.ctx.currentTime + when, bufferOffset, dur);
                this.scheduledNodes.push(src);
            }
            cursor += clip.duration;
        });

        Store.setPlaying(true);
        this.loop();
    },
    stop() {
        this.scheduledNodes.forEach(n => { try{n.stop()}catch(e){} });
        this.scheduledNodes = [];
        Store.setPlaying(false);
        cancelAnimationFrame(this.frame);
    },
    toggle() {
        if (Store.state.isPlaying) this.stop();
        else {
            if (Store.state.currentTime >= Store.state.totalDuration) Store.setCurrentTime(0);
            this.play();
        }
    },
    loop() {
        if (!Store.state.isPlaying) return;
        const now = this.startOffset + (this.ctx.currentTime - this.startTime);
        if (now >= Store.state.totalDuration) {
            Store.setCurrentTime(Store.state.totalDuration); this.stop();
        } else {
            Store.setCurrentTime(now);
            this.frame = requestAnimationFrame(() => this.loop());
        }
    }
};

AudioCore.init(); Timeline.init(); Playlist.init();

const Exporter = {
    async export(start, end) {
        const clips = Store.getClips();
        if (!clips.length) return alert('列表为空');
        if (end <= start) end = Store.state.totalDuration;

        const dur = end - start;
        const sr = 44100;
        const ctx = new OfflineAudioContext(2, dur * sr, sr);
        
        let cursor = 0;
        clips.forEach(clip => {
            const clipStart = cursor;
            const clipEnd = cursor + clip.duration; // 裁剪后的时长

            // 判断是否有交集
            if (clipEnd > start && clipStart < end) {
                const src = ctx.createBufferSource();
                src.buffer = clip.buffer;
                src.connect(ctx.destination);
                
                let playStartTimeInExport = 0; // 在导出文件中的开始时间
                let offsetInClip = 0; // 在 Clip 逻辑时间轴上的偏移
                let playDuration = clip.duration;

                // 1. 计算片段在导出时间轴上的位置
                if (clipStart < start) {
                    // 片段开始时间早于导出开始时间，需要截掉前面一部分
                    offsetInClip = start - clipStart;
                    playDuration -= offsetInClip;
                } else {
                    // 片段在导出范围内开始
                    playStartTimeInExport = clipStart - start;
                }

                // 2. 限制播放时长，防止超出导出结束时间
                if (playStartTimeInExport + playDuration > dur) {
                    playDuration = dur - playStartTimeInExport;
                }

                // 核心修改：实际 Buffer 读取位置 = 裁剪开始点 + 逻辑偏移
                const bufferStartOffset = clip.trimStart + offsetInClip;

                src.start(playStartTimeInExport, bufferStartOffset, playDuration);
            }
            cursor += clip.duration;
        });

        const rendered = await ctx.startRendering();
        const blob = this.toWav(rendered);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `export.mp3`;
        a.click();
    },

    toWav(buffer) {
        const numCh = buffer.numberOfChannels, len = buffer.length, sr = buffer.sampleRate;
        const arr = new ArrayBuffer(44 + len * numCh * 2);
        const view = new DataView(arr);
        const writeString = (o, s) => { for(let i=0;i<s.length;i++) view.setUint8(o+i, s.charCodeAt(i)); };
        
        writeString(0, 'RIFF'); view.setUint32(4, 36 + len * numCh * 2, true); writeString(8, 'WAVE');
        writeString(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
        view.setUint16(22, numCh, true); view.setUint32(24, sr, true); view.setUint32(28, sr * numCh * 2, true);
        view.setUint16(32, numCh * 2, true); view.setUint16(34, 16, true);
        writeString(36, 'data'); view.setUint32(40, len * numCh * 2, true);

        let offset = 44;
        for (let i = 0; i < len; i++) {
            for (let ch = 0; ch < numCh; ch++) {
                let s = buffer.getChannelData(ch)[i];
                s = Math.max(-1, Math.min(1, s));
                view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
                offset += 2;
            }
        }
        return new Blob([arr], {type: 'audio/mp3'});
    }
};

// DOM References
const $ = id => document.getElementById(id);
const els = {
    upload: $('btn-upload'), input: $('file-input'), blank: $('btn-add-blank'),
    play: $('btn-play'), prev: $('btn-prev'), next: $('btn-next'),
    export: $('btn-export'), start: $('export-start'), end: $('export-end'),
    display: $('time-display'),
    modal: $('custom-modal'),
    mConfirm: $('modal-btn-confirm'),
    mCancel: $('modal-btn-cancel'),
    mInput: $('modal-duration-input'),
    tModal: $('trim-modal'), 
    tName: $('trim-filename'),
    tOrigin: $('trim-original-duration'),
    tStart: $('trim-start-input'), 
    tEnd: $('trim-end-input'),
    tConfirm: $('trim-btn-confirm'),
    tCancel: $('trim-btn-cancel')
};

// Upload
els.upload.onclick = () => els.input.click();
els.input.onchange = async (e) => {
    for (const file of e.target.files) {
        const buf = await AudioCore.load(file);
        Store.addClip({ id: Date.now()+Math.random(), buffer: buf, duration: buf.duration, name: file.name });
    }
    els.input.value = '';
};

// Modal for Blank Clip
els.blank.onclick = () => { els.mInput.value = 2; els.modal.style.display = 'flex'; els.mInput.focus(); };
els.mCancel.onclick = () => els.modal.style.display = 'none';
els.mConfirm.onclick = () => {
    const dur = parseFloat(els.mInput.value);
    if (dur > 0) {
        const buf = Utils.createSilentBuffer(AudioCore.ctx, dur);
        Store.addClip({ id: Date.now(), buffer: buf, duration: dur, name: `空白 (${dur}s)` });
        els.modal.style.display = 'none';
    } else alert("请输入有效时长");
};

// Controls
els.play.onclick = () => bus.emit('toggle-play');
bus.on('play-state', (p) => els.play.textContent = p ? '⏸' : '▶');

els.prev.onclick = () => {
    const idx = Math.max(0, Store.getCurrentClipIndex() - 1);
    const t = Store.getClipStartTime(idx);
    bus.emit('seek'); Store.setCurrentTime(t);
};
els.next.onclick = () => {
    const idx = Math.min(Store.state.clips.length, Store.getCurrentClipIndex() + 1);
    const t = Store.getClipStartTime(idx);
    bus.emit('seek'); Store.setCurrentTime(t);
};

// Time Display
bus.on('time-updated', t => els.display.textContent = `${Utils.formatTime(t)} / ${Utils.formatTime(Store.state.totalDuration)}`);
bus.on('state-changed', d => {
    els.display.textContent = `${Utils.formatTime(Store.state.currentTime)} / ${Utils.formatTime(d)}`;
    els.end.value = d.toFixed(1);
});

// Export
els.export.onclick = () => Exporter.export(parseFloat(els.start.value)||0, parseFloat(els.end.value)||0);

let currentTrimId = null;

// 全局函数，供 Playlist HTML调用
window.openTrimModal = (id) => {
    const clip = Store.getClips().find(c => c.id === id);
    if (!clip) return;

    currentTrimId = id;
    els.tName.textContent = `正在裁剪: ${clip.name}`;
    els.tOrigin.textContent = Utils.formatTime(clip.originalDuration);
    
    // 填充当前裁剪值
    els.tStart.value = clip.trimStart;
    els.tEnd.value = clip.trimStart + clip.duration; // 当前结束点 = 开始点 + 持续时长
    
    // 设置最大值限制
    els.tStart.max = clip.originalDuration;
    els.tEnd.max = clip.originalDuration;

    bus.emit('seek'); // 暂停播放
    els.tModal.style.display = 'flex';
};

els.tCancel.onclick = () => els.tModal.style.display = 'none';

els.tConfirm.onclick = () => {
    const s = parseFloat(els.tStart.value);
    const e = parseFloat(els.tEnd.value);
    const clip = Store.getClips().find(c => c.id === currentTrimId);

    if (isNaN(s) || isNaN(e)) return alert('请输入有效数字');
    if (s < 0 || e > clip.originalDuration) return alert('时间超出原始音频范围');
    if (s >= e) return alert('结束时间必须大于开始时间');

    Store.trimClip(currentTrimId, s, e);
    els.tModal.style.display = 'none';
};