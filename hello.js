#!/usr/bin/env node

import axios from 'axios';
import os from 'os';
import path from 'path';
import {MiAccount, MiTokenStore} from "@greatnxy/mi-service/miaccount.js";
import {MiNAService} from "@greatnxy/mi-service/minaservice.js";

const LATEST_ASK_API = "https://userprofile.mina.mi.com/device_profile/v2/conversation?source=dialogu&hardware={hardware}&timestamp={timestamp}&limit=2";

class MiHello {
	constructor(deviceId, hardware, localServer) {
		this.session = axios.create();
		this.miTokenStore = new MiTokenStore(path.join(os.homedir(), '.mi.token'));
		this.miAccount = null;
		this.minaService = null;

		this.deviceId = deviceId;
		this.hardware = hardware;
		this.localServer = localServer;

		this.status = null;
		this.conversation = null;

		this.flag = 'idle';
	}

	async login(miUser, miPass) {
		this.miAccount = new MiAccount(this.session, miUser, miPass, this.miTokenStore);
		await this.miAccount.login("micoapi");
		this.minaService = new MiNAService(this.miAccount);

		const token = this.miTokenStore.loadToken();
		this.cookie = {
			deviceId: this.deviceId,
			serviceToken: token["micoapi"][1],
			userId: token.userId
		};
	}

	async listen() {
		// 对话监听
		const conversationListener = async () => {
			this.getConversation().then(async data => {
				if (data === null) {
					throw new Error("无法获取对话数据。");
				} else if (this.conversation === null) {
					console.info("已启用对话监听，现在可以开始对话了。");
					this.flag = 'idle';
					this.conversation = data;
				} else if (this.conversation.nextEndTime !== data.nextEndTime) {
					console.log("对话:", data.records[0].query);
					this.conversation = data;
					if (!await this.onConversation(data.records[0])) {
						this.flag = 'idle';
					}
				}

				setTimeout(() => conversationListener(), 1000 - data.rateLimit * 30);
			}).catch(e => {
				console.error("对话监听异常：", e.message);
				setTimeout(() => conversationListener(), 3000);
			});
		};
		await conversationListener();

		// 状态守护
		const warnings = {
			"play_local_music": 0
		};
		const statusListener = async () => {
			this.getPlayStatus().then(async status => {
				// 获取最近一条Conversation
				if (this.flag === 'play_local_music' && (status.play_song_detail || (status.status !== 1 && status.status !== 0))) {
					if (warnings["play_local_music"]++ > 5) {
						console.warn("[守护]", "播放本地音乐");
						await this.shutup();
						await this.minaService.playByUrl(this.deviceId, `http://${this.localServer}/random.m3u8`);
					}
				} else {
					warnings["play_local_music"] = 0;
				}
				setTimeout(() => statusListener(), 1000);
			}).catch(e => {
				console.error("状态守护异常：", e.message);
				setTimeout(() => statusListener(), 3000);
			});
		};
		await statusListener();
	}

	async getConversation() {
		const response = await this.session({
			method: 'GET',
			url: LATEST_ASK_API.replace('{hardware}', this.hardware).replace('{timestamp}', String(Date.now())),
			headers: {'Cookie': Object.keys(this.cookie).map(key => `${key}=${this.cookie[key]}`).join('; ')}
		});
		const body = response.data;
		if (body.code !== 0) {
			throw new Error(response.message);
		} else {
			try {
				let data = JSON.parse(body.data);
				// 放入X-Rate-Limit-Remaining的值
				data.rateLimit = response.headers['x-rate-limit-remaining'];
				return data;
			} catch (e) {
				return null;
			}
		}
	}

	async getPlayStatus() {
		const playingInfo = await this.minaService.playerGetStatus(this.deviceId);
		return JSON.parse(playingInfo?.info || "{}");
	}

	async onConversation(record) {
		record.query = record.query.replaceAll(/\s/g, "");
		if (record.query.match(/^(播放|播|放|听)本地的?(音乐|歌([曲单])?|文件|[mn]p3)$/i)) {
			console.log("[操作]", "播放本地音乐");
			this.flag = 'play_local_music';
			await this.shutup();
			await this.talk("好的。");
			await this.minaService.playByUrl(this.deviceId, `http://${this.localServer}/random.m3u8`);
			return true;
		} else if (record.query.match(/^(播放|播|放).+$/i)) {
			if (this.flag === 'play_local_music') {
				await this.shutup();
				await this.talk("不许打断我播放本地音乐。");
				await this.minaService.playByUrl(this.deviceId, `http://${this.localServer}/random.m3u8`);
				return true;
			}
		} else if (record.query.match(/^(([放播换]?下|换)一?[首曲]|切歌)$/i)) {
			if (this.flag === 'play_local_music') {
				console.log("[操作]", "播放下一首本地音乐");
				await this.shutup();
				await this.talk("好的。");
				await this.minaService.playByUrl(this.deviceId, `http://${this.localServer}/random.m3u8`);
				return true;
			}
		} else if (record.query.match(/^((暂停|停止?|别)([唱放播]|播放)?(音乐|歌曲?)?了?|[闭住][口嘴]|再见|拜|退下)+$/i)) {
			if (this.flag === 'play_local_music') {
				console.log("[操作]", "停止播放");
				// 如果回答没有非TTS类型的回答，那么等待播放结束
				if (!record.answers.some(answer => answer.type !== "TTS")) {
					await this.waitUntilStop();
				} else {
					await this.shutup();
				}
				this.flag = 'idle';
				return true;
			}
		} else {
			// 中途和小爱普通对话
			if (this.flag === 'play_local_music') {
				// 如果回答没有非TTS类型的回答，那么等待播放结束
				if (!record.answers.some(answer => answer.type !== "TTS")) {
					await this.waitUntilStop();
				}
				await this.minaService.playByUrl(this.deviceId, `http://${this.localServer}/random.m3u8`);
				return true;
			}
		}
		return false;
	}

	async waitUntilStop() {
		return await new Promise((resolve) => {
			const check = async () => {
				const status = await this.getPlayStatus();
				if (status.status === 3) {
					resolve();
				} else {
					setTimeout(() => check(), 100);
				}
			};
			check();
		});
	}

	async talk(text) {
		await this.minaService.textToSpeech(this.deviceId, text);
		return await this.waitUntilStop();
	}

	async shutup() {
		await this.minaService.playerPause(this.deviceId);
	}
}

// 读取变量
const argStr = process.argv[2];
if (!argStr) {
	console.error("必要参数：MI_DID;MI_HW;MI_LSVR;MI_USER;MI_PASS");
	process.exit(1);
}
let MI_DID, MI_HW, MI_LSVR, MI_USER, MI_PASS;
argStr.split(';').forEach((item) => {
	const [key, value] = item.split('=');
	eval(`${key} = ${value};`);
});
if (!MI_DID || !MI_HW || !MI_LSVR || !MI_USER || !MI_PASS) {
	// 当前参数（列出所有参数）
	console.log('MI_DID:', MI_DID);
	console.log('MI_HW:', MI_HW);
	console.log('MI_LSVR:', MI_LSVR);
	console.log('MI_USER:', MI_USER);
	console.log('MI_PASS:', MI_PASS);

	console.error("必要参数：MI_DID;MI_HW;MI_LSVR;MI_USER;MI_PASS");
	process.exit(1);
}

const miHello = new MiHello(MI_DID, MI_HW, MI_LSVR);
miHello.login(MI_USER, MI_PASS).then(() => miHello.listen());
