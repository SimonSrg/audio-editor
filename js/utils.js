const Utils = {
    // showMs: 是否显示毫秒 (时间轴刻度传 false)
    formatTime(seconds, showMs = true) {
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        const base = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        
        if (showMs) {
            const ms = Math.floor((seconds % 1) * 100);
            return `${base}.${ms.toString().padStart(2, '0')}`;
        }
        return base;
    },
    createSilentBuffer(ctx, duration) {
        return ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    }
};

const Store = {
    state: {
        clips: [], currentTime: 0, isPlaying: false, totalDuration: 0
    },
    getClips() { return this.state.clips; },
    addClip(clip) { this.state.clips.push(clip); this.recalc(); },
    removeClip(id) { this.state.clips = this.state.clips.filter(c => c.id !== id); this.recalc(); },
    reorderClips(from, to) {
        const item = this.state.clips.splice(from, 1)[0];
        this.state.clips.splice(to, 0, item);
        this.recalc();
    },
    recalc() {
        this.state.totalDuration = this.state.clips.reduce((acc, cur) => acc + cur.duration, 0);
        bus.emit('state-changed', this.state.totalDuration);
    },
    setCurrentTime(time) {
        this.state.currentTime = Math.max(0, Math.min(time, this.state.totalDuration));
        bus.emit('time-updated', this.state.currentTime);
    },
    setPlaying(p) { this.state.isPlaying = p; bus.emit('play-state', p); },
    getClipStartTime(idx) {
        let t = 0; for (let i = 0; i < idx; i++) t += this.state.clips[i].duration; return t;
    },
    getCurrentClipIndex() {
        let t = 0;
        for (let i = 0; i < this.state.clips.length; i++) {
            if (this.state.currentTime >= t && this.state.currentTime < t + this.state.clips[i].duration) return i;
            t += this.state.clips[i].duration;
        }
        return Math.max(0, this.state.clips.length - 1);
    }
};