#!/usr/bin/env node

import axios from 'axios';
import os from 'os';
import path from 'path';
import {MiAccount, MiTokenStore} from "@greatnxy/mi-service/miaccount.js";
import {MiNAService} from "@greatnxy/mi-service/minaservice.js";

import readline from "readline";

const LATEST_ASK_API = "https://userprofile.mina.mi.com/device_profile/v2/conversation?source=dialogu&hardware={hardware}&timestamp={timestamp}&limit=2";
const REQUEST_TIMEOUT = 2000;

class MiHello {
	constructor(deviceId, hardware, localServer) {
		this.session = axios.create({timeout: REQUEST_TIMEOUT});

		this.miTokenStore = new MiTokenStore(path.join(os.homedir(), '.mi.token'));
		this.miAccount = null;
		this.minaService = null;

		this.deviceId = deviceId;
		this.hardware = hardware;
		this.localServer = localServer;

		this.status = null;
		this.conversation = null;
		this.lastRecord = null;

		this.flag = 'idle';
	}

	async login(miUser, miPass) {
		this.miAccount = new MiAccount(this.session, miUser, miPass, this.miTokenStore);
		await this.miAccount.login("micoapi");
		this.minaService = new MiNAService(this.miAccount);
	}

	async listen() {
		// 对话监听
		const conversationListener = async () => {
			this.getConversation().then(async data => {
				if (data === null) {
					throw new Error("获取对话信息失败。");
				} else if (this.conversation === null) {
					console.info("已启用对话监听，现在可以开始对话了。");
					this.flag = 'idle';
					this.conversation = data;
					this.lastRecord = data.records[0];
				} else if (this.conversation.nextEndTime !== data.nextEndTime) {
					data.records.reverse();
					for (const record of data.records) {
						if (record.time > this.lastRecord.time) {
							console.log("对话:", record.query);
							if (!await this.onConversation(record)) {
								this.flag = 'idle';
							}
							this.lastRecord = record;
						}
					}
					this.conversation = data;
				}

				setTimeout(() => conversationListener(), 1000 - data.rateLimit * 30);
			}).catch(e => {
				console.error("[监听]", "获取对话信息时受阻:", e);
				setTimeout(() => conversationListener(), 3000);
			});
		};
		await conversationListener();

		// 状态守护
		const warnings = {
			"play_local_music": 0
		};

		// 守护状态白名单
		const protectWhitelist = ['play_local_music'];
		const statusListener = async () => {
			if (protectWhitelist.includes(this.flag)) {
				this.getPlayStatus().then(async status => {
					// 获取最近一条Conversation
					switch (this.flag) {
						case 'play_local_music': {
							if (status.play_song_detail || (status.status !== 1 && status.status !== 0)) {
								if (warnings["play_local_music"]++ > 5) {
									console.warn("[守护]", "播放本地音乐");
									await this.shutup();
									await this.minaService.playByUrl(this.deviceId, `http://${this.localServer}/random.m3u8`);
								} else {
									console.warn("[守护]", `本地音乐播放异常(${status.status})`, warnings["play_local_music"]);
								}
							} else {
								warnings["play_local_music"] = 0;
							}
							break;
						}
					}
					setTimeout(() => statusListener(), 1000);
				}).catch(e => {
					console.error("[守护]", "获取播放状态时受阻:", e.message);
					setTimeout(() => statusListener(), 3000);
				});
			} else {
				// 当前状态不需要守护，只重置守护状态
				protectWhitelist.forEach(key => warnings[key] = 0);
				setTimeout(() => statusListener(), 1000);
			}
		};
		await statusListener();
	}

	async getConversation() {
		const response = await this.miAccount.miRequest('micoapi', {
			url: LATEST_ASK_API.replace('{hardware}', this.hardware).replace('{timestamp}', String(Date.now())),
			headers: {
				'Cookie': {deviceId: this.deviceId}
			}
		}, {rawReps: true});
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
		switch (this.flag) {
			case 'idle': {
				if (record.query.match(/^(播放|播|放|听)本地的?(音乐|歌([曲单])?|文件|[mn]p3)$/i)) {
					console.log("[操作]", "播放本地音乐");
					this.flag = 'play_local_music';
					await this.shutup();
					await this.talk("好的。");
					await this.minaService.playByUrl(this.deviceId, `http://${this.localServer}/random.m3u8`);
					return true;
				}
				break;
			}
			case 'play_local_music': {
				if (record.query.match(/^(播放|播|放).+$/i)) {
					console.log("[操作]", "阻止打断播放本地音乐");
					await this.shutup();
					await this.talk("不许打断我播放本地音乐。");
					await this.minaService.playByUrl(this.deviceId, `http://${this.localServer}/random.m3u8`);
					return true;
				} else if (record.query.match(/^(([放播换]?[上下]|换)一?[首曲]|[切换]歌)$/i)) {
					console.log("[操作]", "播放下一首本地音乐");
					await this.shutup();
					await this.minaService.playByUrl(this.deviceId, `http://${this.localServer}/random.m3u8`);
					return true;
				} else if (record.query.match(/^((暂停|停止?|别)([唱放播]|播放)?(音乐|歌曲?)?了?|[闭住][口嘴]|再见|拜|退下)+$/i)) {
					console.log("[操作]", "停止播放");
					this.flag = 'idle';
					// 如果回答没有非TTS类型的回答，那么等待播放结束
					if (record.answers.length && !record.answers.some(answer => answer.type !== "TTS")) {
						await this.waitUntilStop();
					} else {
						await this.shutup();
					}
					return true;
				} else {
					// 中途和小爱普通对话
					console.log("[操作]", "对话后继续播放本地音乐");
					// 如果回答没有非TTS类型的回答，那么等待播放结束
					if (record.answers.length && !record.answers.some(answer => answer.type !== "TTS")) {
						await this.waitUntilStop();
					}
					await this.minaService.playByUrl(this.deviceId, `http://${this.localServer}/random.m3u8`);
					return true;
				}
			}
		}
		return false;
	}

	async waitUntilStop() {
		let count = 0;
		return await new Promise((resolve) => {
			const check = async () => {
				try {
					const status = await this.getPlayStatus();
					if (status.status === 3) {
						resolve();
					} else if (count++ > 600) {
						console.trace("[疑点]", `等待播放结束超时(${status.status})`);
						resolve();
					} else {
						setTimeout(() => check(), 100);
					}
				} catch (e) {
					console.error("[异常]", "等待播放结束异常", e.message);
					resolve();
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
	console.error("必要参数：MI_LSVR;MI_USER;MI_PASS");
	console.error("可选参数：MI_DID;MI_HW");
	process.exit(1);
}

let MI_DID, MI_HW, MI_LSVR, MI_USER, MI_PASS;
argStr.split(';').forEach((item) => {
	const [key, value] = item.split('=');
	eval(`${key} = ${value};`);
});

if (!MI_LSVR || !MI_USER || !MI_PASS) {
	// 当前参数（列出所有参数）
	console.log('MI_LSVR:', MI_LSVR);
	console.log('MI_USER:', MI_USER);
	console.log('MI_PASS:', MI_PASS);

	console.error("必要参数：MI_LSVR;MI_USER;MI_PASS");
	console.error("可选参数：MI_DID;MI_HW");

	process.exit(1);
}

if (!MI_DID || !MI_HW) {
	const tmpSession = axios.create();
	const tmpAccount = new MiAccount(tmpSession, MI_USER, MI_PASS, null);
	const tmpNA = new MiNAService(tmpAccount);
	await tmpNA.deviceList().then((value) => {
		// 列出所有设备，然后让选择
		console.log('设备列表:');
		value.forEach((item, index) => {
			console.log(`[${index}]`, item.name, `(型号：${item.hardware})`);
		});
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout
		});
		// 让用户选择设备
		rl.question('请选择目标设备的序号: ', (answer) => {
			rl.close();
			const device = value[parseInt(answer)];
			if (device) {
				console.log('MI_DID:', device.deviceID);
				console.log('MI_HW:', device.hardware);
				MI_DID = device.deviceID;
				MI_HW = device.hardware;
				start();
			} else {
				console.error('设备序号无效。');
				process.exit(1);
			}
		});
	});
} else {
	start();
}

function start() {
	const miHello = new MiHello(MI_DID, MI_HW, MI_LSVR);
	miHello.login(MI_USER, MI_PASS).then(() => miHello.listen());
}