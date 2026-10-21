// Webcam selfie: the camera frame is read into a canvas, turned into an in-memory PNG File and handed to the same path as a chosen photo.
// Nothing is recorded or uploaded: video only (no microphone), the stream stays in a <video> element in this page, the stream is stopped
// the moment a frame is taken or the camera is closed, and the File never leaves memory.

/** @returns {{ start: () => Promise<void>, capture: () => Promise<File>, stop: () => void, readonly active: boolean }} */
export function createSelfie( video ) {

	let stream = null;

	const stop = () => {

		if ( stream ) for ( const t of stream.getTracks() ) t.stop();
		stream = null;
		video.srcObject = null;

	};

	return {

		get active() { return !! stream; },

		async start() {

			if ( ! navigator.mediaDevices || ! navigator.mediaDevices.getUserMedia ) throw new Error( 'This browser has no camera access (it needs a secure page, https or localhost).' );
			stop();
			stream = await navigator.mediaDevices.getUserMedia( { video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false } );
			video.srcObject = stream;
			video.muted = true; video.playsInline = true;
			await video.play();

		},

		/** Takes the current frame (not mirrored, so left and right are the person's own) and stops the camera. */
		async capture() {

			if ( ! stream || ! video.videoWidth ) throw new Error( 'The camera is not ready yet.' );
			const c = document.createElement( 'canvas' );
			c.width = video.videoWidth; c.height = video.videoHeight;
			c.getContext( '2d' ).drawImage( video, 0, 0 );
			const blob = await new Promise( ( resolve, reject ) => c.toBlob( b => b ? resolve( b ) : reject( new Error( 'Could not encode the frame.' ) ), 'image/png' ) );
			stop();
			return new File( [ blob ], 'selfie.png', { type: 'image/png' } );

		},

		stop,

	};

}
