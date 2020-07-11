const fs = require("fs").promises;
const path = require("path");
const os = require("os");
const spawn = require("child_process").spawn;
const rimraf = require("rimraf");
const {argv} = require("yargs")
	.option("algo", {
		demandOption: true,
		describe: "Which algo to use. 1: ffmpeg overlay, 2: ffmpeg xfade, 3: melt",
		choices: [1, 2, 3],
		type: "number",
	})
	.option("images", {
		demandOption: true,
		describe: "How many images are generated",
		type: "number",
	})
	.option("imageDuration", {
		demandOption: true,
		describe: "How long each image is shown (in seconds)",
		type: "number",
	})
	.option("filename", {
		demandOption: true,
		describe: "The name of the output file. It will be put into the output directory. Must end with mp4",
		type: "string",
	})
	.check((argv) => {
		return Number.isInteger(argv.images) && argv.images >= 2 && argv.imageDuration > 0 && argv.filename.endsWith(".mp4");
	});

const { createCanvas } = require("canvas");

const withTempDir = async (fn) => {
	const dir = await fs.mkdtemp(await fs.realpath(os.tmpdir()) + path.sep);
	try {
		return await fn(dir);
	}finally {
		rimraf(dir, () => {});
	}
};

const getImage = (text) => {
	const width = 1920;
	const height = 1080;

	const canvas = createCanvas(width, height);
	const context = canvas.getContext("2d");

	context.fillStyle = "#FFFFFF";
	context.fillRect(0, 0, width, height);

	context.font = "bold 450pt Helvetica, sans";
	context.textAlign = "center";
	context.textBaseline = "middle";

	context.fillStyle = "#000000";
	context.fillText(text, width / 2, height / 2);

	return canvas.toBuffer("image/png");
};

const getImageSequence = (num) => {
	return Array(num).fill().map((_e, i) => getImage(i));
};

const generateVideoV1 = (filename) => async (sequence) => {
	const crossfadetime = 0.5;

	return withTempDir(async (dir) => {
		await Promise.all(sequence.map(({image}, index) => fs.writeFile(path.join(dir, `${index}.png`), image)));

		const inputs = sequence.map(({duration}, index) => {
			return `-loop 1 -t ${duration + crossfadetime} -i ${dir}/${index}.png`;
		}).join(" ");

		const filterComplex1 = sequence.filter((_t, i) => i < sequence.length - 1).map((_v, index) => {
			const startTime = sequence.reduce((memo, {duration}, idx) => idx > index ? memo : memo + duration, 0);

			return `[${index + 1}]fade=d=${crossfadetime}:t=in:alpha=1,setpts=PTS-STARTPTS+${startTime}/TB[f${index}];`;
		}).join(" ");
		const filterComplex2 = sequence.filter((_t, i) => i < sequence.length - 1).map((_v, index) => {
			return `[${index === 0 ? "0" : `bg${index}`}][f${index}]overlay${index !== sequence.length - 2 ? `[bg${(index + 1)}]` : ""}`;
		}).join(";");

		await new Promise((res, rej) => {
			const ffmpeg = spawn("ffmpeg", ["-y", ...inputs.split(" "), "-filter_complex", `${filterComplex1} ${filterComplex2},format=yuv420p[v]`, "-map", "[v]", "-movflags", "+faststart", `/tmp/output/${filename}`]);
			ffmpeg.stderr.on("data", (data) => {
				console.log(data.toString("utf-8"));
			});
			ffmpeg.stdout.on("data", (data) => {
				console.log(data.toString("utf-8"));
			});
			ffmpeg.on("close", (code) => {
				if (code === 0) {
					res();
				}else {
					rej(code);
				}
			});
			ffmpeg.on("error", rej);
		});
	});
};

const generateVideoV2 = (filename) => async (sequence) => {
	const crossfadetime = 0.5;

	return withTempDir(async (dir) => {
		await Promise.all(sequence.map(({image}, index) => fs.writeFile(path.join(dir, `${index}.png`), image)));

		const inputs = sequence.map(({duration}, index) => {
			return `-loop 1 -t ${duration + crossfadetime} -i ${dir}/${index}.png`;
		}).join(" ");

		const filterComplex1 = sequence.filter((_t, i) => i < sequence.length - 1).map((_v, index) => {
			const startTime = sequence.reduce((memo, {duration}, idx) => idx > index ? memo : memo + duration, 0);
			return `[${index === 0 ? "0" : `f${index}`}][${index + 1}]xfade=transition=fade:duration=${crossfadetime}:offset=${startTime}${index !== sequence.length - 2 ? `[f${index + 1}]`: ",format=yuv420p[v]"}`;
		}).join(";");

		await new Promise((res, rej) => {
			const ffmpeg = spawn("ffmpeg", ["-y", ...inputs.split(" "), "-filter_complex", `${filterComplex1}`, "-map", "[v]", "-movflags", "+faststart", "-r", "25", `/tmp/output/${filename}`]);
			ffmpeg.stderr.on("data", (data) => {
				console.log(data.toString("utf-8"));
			});
			ffmpeg.stdout.on("data", (data) => {
				console.log(data.toString("utf-8"));
			});
			ffmpeg.on("close", (code) => {
				if (code === 0) {
					res();
				}else {
					rej(code);
				}
			});
			ffmpeg.on("error", rej);
		});
	});
};

const generateVideoV3 = (filename) => async (sequence) => {
	const fps = 25;
	const crossfadetime = 0.5;
	const crossfadeInFrames = Math.floor(fps * crossfadetime);

	return withTempDir(async (dir) => {
		await Promise.all(sequence.map(({image}, index) => fs.writeFile(path.join(dir, `${index}.png`), image)));

		const timedSequence = sequence.reduce((memo, e) => {
			return [
				...memo,
				{
					...e,
					startFrame: (memo.reduce((m, e) => m + e.duration, 0)) * fps + memo.length * crossfadeInFrames,
				}
			];
		}, []);
		const videolength = sequence.reduce((memo, e) => memo + e.duration * fps, 0) + (sequence.length - 1) * crossfadeInFrames;

		const config = timedSequence.map(({startFrame}, index) => {
			const nextStartFrame = index !== timedSequence.length - 1 ? timedSequence[index + 1].startFrame : videolength;
			const durationInFrames = nextStartFrame - startFrame;
			return `${dir}/${index}.png out=${durationInFrames + crossfadeInFrames}${index !== 0 ? ` -mix ${crossfadeInFrames} -mixer luma` : ""}`;
		}).join(" ");

		await new Promise((res, rej) => {
			const ffmpeg = spawn("melt", [...config.split(" "), "-consumer", `avformat:/tmp/output/${filename}`, `frame_rate_num=${fps}`, "width=1920", "height=1080", "sample_aspect_num=1", "sample_aspect_den=1"]);
			ffmpeg.stderr.on("data", (data) => {
				console.log(data.toString("utf-8"));
			});
			ffmpeg.stdout.on("data", (data) => {
				console.log(data.toString("utf-8"));
			});
			ffmpeg.on("close", (code) => {
				if (code === 0) {
					res();
				}else {
					rej(code);
				}
			});
			ffmpeg.on("error", rej);
		});
	});
};

["SIGINT", "SIGTERM"].forEach((signal) => process.on(signal, () => process.exit(0)));

(async () => {
	try {
		await fs.unlink(`/tmp/output/${argv.filename}`);
	}catch(e){}
	const numImages = argv.images;

	const sequence = getImageSequence(numImages).map((image) => {
		return {
			image,
			duration: argv.imageDuration,
		};
	});
	
	const algo = (() => {
		switch(argv.algo) {
		case 1: return generateVideoV1;
		case 2: return generateVideoV2;
		case 3: return generateVideoV3;
		}
	})();
	await algo(argv.filename)(sequence);
})();
