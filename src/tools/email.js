// import nodemailer from 'nodemailer';
// import { config } from '../config/index.js';
// import { logger } from '../utils/logger.js';

// let transporter = null;

// function getTransporter() {
//   if (!transporter) {
//     transporter = nodemailer.createTransport({
//       host: config.smtp.host,
//       port: config.smtp.port,
//       secure: config.smtp.port === 465,
//       auth: { user: config.smtp.user, pass: config.smtp.pass },
//     });
//   }
//   return transporter;
// }

// /**
//  * Send a meeting confirmation email.
//  */
// export async function sendMeetingEmail({ to, name, date, time, confirmationId, product }) {
//   if (!to) {
//     logger.warn('[email] No recipient — skipping email send');
//     return { sent: false, reason: 'No email address provided' };
//   }

//   const subject = `Demo Confirmed — ${product || 'TechSolutions'} on ${date} at ${time} IST`;
//   const html = `
//     <h2>Your demo is confirmed! 🎉</h2>
//     <p>Hi ${name || 'there'},</p>
//     <p>Your product demo has been scheduled:</p>
//     <ul>
//       <li><strong>Product:</strong> ${product || 'TechSolutions India'}</li>
//       <li><strong>Date:</strong> ${date}</li>
//       <li><strong>Time:</strong> ${time} IST</li>
//       <li><strong>Duration:</strong> 30 minutes</li>
//       <li><strong>Confirmation ID:</strong> ${confirmationId}</li>
//     </ul>
//     <p>Our team will call you at the scheduled time. If you need to reschedule, reply to this email.</p>
//     <p>See you soon!<br/>— TechSolutions India Team</p>
//   `;

//   try {
//     const info = await getTransporter().sendMail({
//       from: config.smtp.from,
//       to,
//       subject,
//       html,
//     });
//     logger.info(`[email] Sent to ${to} — messageId: ${info.messageId}`);
//     return { sent: true, messageId: info.messageId };
//   } catch (err) {
//     logger.error(`[email] Send failed: ${err.message}`);
//     return { sent: false, reason: err.message };
//   }
// }

// export const emailToolDefinitions = [
//   {
//     name: 'send_meeting_email',
//     description: 'Send a calendar confirmation email to the caller after booking a demo.',
//     input_schema: {
//       type: 'object',
//       properties: {
//         to:             { type: 'string', description: 'Recipient email address' },
//         name:           { type: 'string' },
//         date:           { type: 'string' },
//         time:           { type: 'string' },
//         confirmationId: { type: 'string' },
//         product:        { type: 'string' },
//       },
//       required: ['to', 'date', 'time', 'confirmationId'],
//     },
//   },
// ];

// export const emailToolHandlers = {
//   send_meeting_email: sendMeetingEmail,
// };


import { tool } from "@langchain/core/tools";
import nodemailer from "nodemailer";
import { z } from "zod";
import "dotenv/config"; 
import { config } from '../config/index.js';

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: config.smtp.user,
    pass: config.smtp.pass,
  },
});

export const sendMeetingEmailTool = tool(
  async ({ userName, userEmail, date, time }) => {
    const managerEmail = config.smtp.admin;

    const mailOptions = {
      from: `"Xverse Assistant" <${process.env.EMAIL_USER}>`,
      to: `${userEmail}, ${managerEmail}`,
      subject: `✅ Meeting Confirmed: ${userName} x Xverse`,
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6;">
          <h2>Meeting Confirmation</h2>
          <p>Hi <strong>${userName}</strong>,</p>
          <p>Your meeting with Xverse Technologies has been successfully scheduled.</p>
          <hr />
          <p>📅 <strong>Date:</strong> ${date}</p>
          <p>🕒 <strong>Time:</strong> ${time} (Asia/Kolkata)</p>
          <p>📍 <strong>Platform:</strong> Google Meet (Link in Calendar Invite)</p>
          <hr />
          <p>We look forward to discussing your AI requirements.</p>
          <p>Best Regards,<br><strong>Ansh</strong><br>Xverse Technologies</p>
        </div>
      `,
    };

    try {
      await transporter.sendMail(mailOptions);
      return `SUCCESS: Confirmation email sent to ${userEmail}`;
    } catch (e) {
      console.error("Email Error:", e);
      return "FAILURE: Could not send confirmation email.";
    }
  },
  {
    name: "send_meeting_email",
    description: "Sends a professional confirmation email to the user and manager with specific date and time.",
    schema: z.object({
      userName: z.string().describe("The name of the user"),
      userEmail: z.string().email().describe("The user's email address"),
      date: z.string().describe("The confirmed date of the meeting"),
      time: z.string().describe("The confirmed time of the meeting"),
    }),
  }
);