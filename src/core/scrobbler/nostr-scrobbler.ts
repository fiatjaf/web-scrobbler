'use strict';

import type { BaseSong } from '@/core/object/song';
import BaseScrobbler from '@/core/scrobbler/base-scrobbler';
import type { SessionData } from './base-scrobbler';
import { ServiceCallResult } from '../object/service-call-result';
import type ClonedSong from '../object/cloned-song';
import { generateSecretKey } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import {
	type BunkerPointer,
	BunkerSigner,
	parseBunkerInput,
} from 'nostr-tools/nip46';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { npubEncode } from 'nostr-tools/nip19';
import { backgroundListener, setupBackgroundListeners } from '@/util/communication';

/**
 * Module for all communication with a custom webhook
 */

export default class NostrScrobbler extends BaseScrobbler<'Nostr'> {
	public isLocalOnly = true;
	public bunkerUri!: string;
	private bunker: BunkerSigner | undefined;
	private pool = new SimplePool();

	private cached: {
		publicKey?: string;
		writeRelays?: string[];
		metadata?: { name?: string };
	} = {};

	constructor() {
		setupBackgroundListeners(
			backgroundListener({
				type: 'updateScrobblerProperties',
				fn: () => {
					this.bunkerUri = '';
					this.cached = {};
					this.bunker = undefined;
					setTimeout(() => this.getPublicKey(), 500);
				},
			}),
		);
		super();
	}

	private async getPublicKey() {
		if (this.cached.publicKey) {
			return this.cached.publicKey;
		}

		const bunker = await this.getBunker();
		if (bunker) {
			this.cached.publicKey = await bunker.getPublicKey();
		}

		return this.cached.publicKey;
	}

	private async getWriteRelays(): Promise<string[]> {
		if (this.cached.writeRelays) {
			return this.cached.writeRelays;
		}

		const pubkey = await this.getPublicKey();
		if (pubkey) {
			const events = await this.pool.querySync(
				['wss://purplepag.es', 'wss://indexer.coracle.social'],
				{
					kinds: [10002],
					authors: [pubkey],
					limit: 1,
				},
				{
					maxWait: 500,
				}
			);
			if (events.length >= 1) {
				this.cached.writeRelays = events[0].tags
					.filter((t) => t[0] === 'r' && t.length >= 2)
					.filter(
						(t) =>
							t[2] === undefined ||
							t[2] === '' ||
							t[2] === 'write',
					)
					.map((t) => t[1]);
			}

			this.cached.writeRelays = this.cached.writeRelays || [
				'wss://relay.primal.net',
				'wss://nos.lol',
				'wss://relay.damus.io',
			]
		}

		return this.cached.writeRelays;
	}

	private async getMetadata() {
		if (this.cached.metadata) {
			return this.cached.metadata;
		}

		const pubkey = await this.getPublicKey();
		const relays = (await this.getWriteRelays()) || [];
		if (!pubkey) {
			return {};
		}

		const events = await this.pool.querySync(
			['wss://purplepag.es', 'wss://indexer.coracle.social', ...relays],
			{
				kinds: [0],
				authors: [pubkey],
				limit: 1,
			},
			{
				maxWait: 500,
			}
		);
		if (events.length >= 1) {
			try {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
				const metadata = JSON.parse(events[0].content) as { name: string };
				if (metadata?.name) {
					this.cached.metadata = { name: metadata.name as string };
				}
			} catch (err) {
				// do nothing, their metadata is invalid
			}
		}

		this.cached.metadata = this.cached.metadata || {};
		return this.cached.metadata;
	}

	/** @override */
	public getBaseProfileUrl(): string {
		return "";
	}

	/** @override */
	public async getProfileUrl(): Promise<string> {
		const pubkey = await this.getPublicKey();
		if (pubkey) {
			const npub = npubEncode(pubkey);
			return Promise.resolve(`https://nosta.me/${npub}`);
		}
		return Promise.resolve('');
	}

	/** @override */
	getLabel(): 'Nostr' {
		return 'Nostr';
	}

	/** @override */
	getStatusUrl(): string {
		return '';
	}

	/** @override */
	getStorageName(): 'Nostr' {
		return 'Nostr';
	}

	async getBunker(): Promise<BunkerSigner | null> {
		if (this.bunker) {
			return this.bunker;
		}

		const data = await this.storage.get();
		if (!data?.properties) {
			return null;
		}
		const { properties } = data;

		if (properties && properties.bunkerUri) {
			const clientKey = properties.clientKey
				? hexToBytes(properties.clientKey)
				: generateSecretKey();
			if (!properties.clientKey) {
				properties.clientKey = bytesToHex(clientKey);
				await this.storage.set({ properties });
			}

			let bunkerP: BunkerPointer;
			try {
				const b = await parseBunkerInput(properties.bunkerUri);
				if (!b) {
					return null;
				}
				bunkerP = b;
			} catch (err) {
				return null;
			}
			this.bunker = new BunkerSigner(clientKey, bunkerP, {
				pool: this.pool,
				onauth: (url) => {
					window.open(url)
				},
			});
			await this.bunker.connect();
			return this.bunker;
		}

		return null;
	}

	/** @override */
	async getSession(): Promise<SessionData> {
		const pubkey = await this.getPublicKey();
		const metadata = await this.getMetadata();

		if (metadata || pubkey) {
			const npub = npubEncode(pubkey!);
			return {
				sessionID: 'nostr',
				sessionName: metadata?.name
					? `${metadata.name} (${npub.slice(0, 7)}…${npub.slice(-5)})`
					: npub,
			};
		}

		throw new Error('No bunker configured');
	}

	public async getSongInfo(): Promise<Record<string, never>> {
		return Promise.resolve({});
	}

	/** @override */
	async sendNowPlaying(song: BaseSong): Promise<ServiceCallResult> {
		const bunker = await this.getBunker();
		if (!bunker) {
			return ServiceCallResult.ERROR_AUTH;
		}

		// publish a NIP-38 music status
		const title = song.processed.track || song.parsed.track;
		const artist = song.processed.artist || song.parsed.artist;
		const album = song.processed.album || song.parsed.album;
		const duration = song.getDuration() || 5 * 60;

		if (!title || !artist) {
			return ServiceCallResult.RESULT_IGNORE;
		}

		let content = `🎵 ${artist} - ${title}`;
		if (album) {
			content += ` (${album})`;
		}

		const tags: string[][] = [['d', 'music']];
		if (duration) {
			const expirationTime = Math.floor(Date.now() / 1000) + duration;
			tags.push(['expiration', expirationTime.toString()]);
		}
		const originUrl = song.getOriginUrl();
		if (originUrl) {
			tags.push(['r', originUrl]);
		}

		const signedEvent = await bunker.signEvent({
			kind: 30315,
			created_at: Math.floor(Date.now() / 1000),
			content,
			tags,
		});

		const relays = await this.getWriteRelays();
		this.pool.publish(relays, signedEvent);

		return ServiceCallResult.RESULT_OK;
	}

	/** @override */
	sendPaused(_song: BaseSong): Promise<ServiceCallResult> {
		return Promise.resolve(ServiceCallResult.RESULT_IGNORE);
	}

	/** @override */
	sendResumedPlaying(song: BaseSong): Promise<ServiceCallResult> {
		return this.sendNowPlaying(song);
	}

	/** @override */
	public async scrobble(
		songs: BaseSong[],
		_currentlyPlaying: boolean,
	): Promise<ServiceCallResult[]> {
		const bunker = await this.getBunker();
		if (!bunker) {
			return songs.map(() => ServiceCallResult.ERROR_AUTH);
		}

		const results: ServiceCallResult[] = [];
		for (const song of songs) {
			const title = song.processed.track || song.parsed.track;
			const artist = song.processed.artist || song.parsed.artist;
			const album = song.processed.album || song.parsed.album;

			if (!title || !artist) {
				results.push(ServiceCallResult.RESULT_IGNORE);
				continue;
			}

			const tags: string[][] = [
				['title', title],
				['artist', artist],
			];
			if (album) {
				tags.push(['album', album]);
			}

			// TODO: add isrc

			const signedEvent = await bunker.signEvent({
				kind: 1073,
				created_at: song.metadata.startTimestamp,
				content: '',
				tags,
			});

			const relays = (await this.getWriteRelays()) || [
				'wss://relay.primal.net',
				'wss://nos.lol',
				'wss://relay.damus.io',
			];
			this.pool.publish(relays, signedEvent);

			results.push(ServiceCallResult.RESULT_OK);
		}

		return results;
	}

	/** @override */
	public toggleLove(
		_song: ClonedSong,
		_isLoved: boolean,
	): Promise<ServiceCallResult | Record<string, never>> {
		return Promise.resolve(ServiceCallResult.RESULT_IGNORE);
	}

	public isReadyForGrantAccess(): Promise<boolean> {
		if (this.bunkerUri && !this.bunker) {
			return Promise.resolve(true);
		}
		return Promise.resolve(false);
	}

	/** @override */
	public getUserDefinedProperties(): string[] {
		return ['bunkerUri', 'clientKey'];
	}
}
