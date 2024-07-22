const { body } = require("express-validator");
const asyncHandler = require("../../middlewares/asyncHandler");
const { exec } = require("child_process");
const ErrorResponse = require("../../utils/ErrorResponse");
const fs = require("fs");
const Question = require("../../models/Question");
const axios = require("axios");
const Queue = require("bull");
const submission_file_path = "./processing/sub.cpp";
const executable_file_path = "./a.out";
const input_file_path = "./input.txt";
const solution_file_path = "./solution.txt";
const output_file_path = "./output.txt";

const submissionQueue = new Queue("submissions", {
  redis: { port: process.env.REDIS_PORT, host: process.env.REDIS_HOST },
});

submissionQueue.process(async (job, done) => {
  try {
    const { question_id } = job.data;

    const question = await Question.findById(question_id);
    const {
      time_limit,
      solution_file: solution_file_url,
      input_file: input_file_url,
    } = question;

    const {base64_encoded_data : submission_file} = job.data;

    const { data: input_file } = await axios.get(input_file_url);
    const { data: solution_file } = await axios.get(solution_file_url);
    await downloadFile(String(input_file), input_file_path, "TEXT");
    await downloadFile(String(solution_file), solution_file_path, "TEXT");
    await downloadFile(submission_file, submission_file_path, "BUFFER");

    await execShellCommand(`g++ ${submission_file_path}`);

    let execution_time = await execShellCommand(
      `time timeout ${time_limit + 1}s ${executable_file_path}`
    );

    execution_time = Number(
      execution_time.split("system 0:0")[1].split("e")[0]
    );

    const correctAnswer = await compareFiles(
      solution_file_path,
      output_file_path
    );

    await deleteFile(submission_file_path);
    await deleteFile(executable_file_path);
    await deleteFile(input_file_path);
    await deleteFile(solution_file_path);
    await deleteFile(output_file_path);

    console.log("correctAnswer: ", correctAnswer);

    done(null, { message: "working", execution_time: execution_time, correctAnswer: correctAnswer });

  } catch (error) {
    console.log("LoL error", error.message);
    done(error);
  }
});

const execShellCommand = (cmd) => {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 10000 }, (error, stdout, stderr) => {
      if (error) {
        console.warn(error);
      }
      resolve(stdout ? stdout : stderr);
    });
  });
};

const compareFiles = async (file_path1, file_path2) => {
  const command = `bash -c "diff <(tr -d '\r' <${file_path1}) <(tr -d '\r' <${file_path2})"`;
  const difference = await execShellCommand(command);
  return !difference;
};

const downloadFile = (file, file_path, mode) => {
  let data;
  if(mode == "TEXT"){
    data = file;
  }else{
    data = Buffer.from(file, "base64");
  }
  return new Promise((resolve, reject) => {
    fs.writeFile(file_path, data, (err) => {
      if (err) {
        return reject();
      }
      return resolve();
    });
  });
};

const deleteFile = (file_path) => {
  return new Promise((resolve, reject) => {
    fs.unlink(file_path, (err) => {
      if (err) {
        reject();
      }
      return resolve();
    });
  });
};

exports.checkSubmitRequest = [
  body("question_id").exists().withMessage("Question ID is Required").bail(),
  body("question_id")
    .isMongoId()
    .withMessage("Question ID must be a valid Mongo ID")
    .bail(),
  body("question_id").custom(async (value, { req }) => {
    const question_exists = await Question.findById(value);
    if (!question_exists) throw new ErrorResponse("No Such Question Exists");
    return true;
  }),
  body().custom((value, { req }) => {
    if (!req.files?.submission_file?.length) {
      throw new ErrorResponse("Submission File is Required");
    }
    return true;
  }),
];

exports.submitFile = asyncHandler(async (req, res) => {
  const {question_id} = req.body;
  const base64_encoded_data = req.files.submission_file[0].buffer.toString('base64');

  const job = await submissionQueue.add({question_id, base64_encoded_data});
  const result = await job.finished();

  res.json(result);
});
