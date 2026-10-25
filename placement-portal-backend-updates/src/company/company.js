
const { Hono } = require('hono');

// Adjust path as needed
import { authMiddleware } from '../middleware/Authenticate';

const company = new Hono();

// Send notifications to the notification service.
// Configure NOTIFICATION_SERVICE_URL and NOTIFICATION_EVENT_SECRET
// as private Cloudflare Worker environment variables.
const sendPortalNotification = async (env, payload) => {
  if (!env.NOTIFICATION_SERVICE_URL || !env.NOTIFICATION_EVENT_SECRET) {
    console.error('Notification service configuration is missing.');
    return;
  }

  try {
    const response = await fetch(
      `${env.NOTIFICATION_SERVICE_URL.replace(/\/$/, '')}/api/events`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-notification-secret': env.NOTIFICATION_EVENT_SECRET
        },
        body: JSON.stringify(payload)
      }
    );

    if (!response.ok) {
      console.error(
        'Notification request failed:',
        response.status,
        await response.text()
      );
    }
  } catch (error) {
    // Notification failures should not undo a successful placement operation.
    console.error('Unable to reach notification service:', error.message);
  }
};

const uploadToR2 = async (bucket, file, folder, filenamePrefix) => {
  if (!file || !(file instanceof File)) return null;

  const ext = file.name.split('.').pop();
  const key = `${folder}/${filenamePrefix}_${crypto.randomUUID()}.${ext}`;

  await bucket.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type }
  });

  const baseUrl = 'https://api.dmceplacement.com/logo';
  return `${baseUrl}/${folder}/${key.split('/').pop()}`;
};

company.use('*', authMiddleware);

// ---------- COMPANY PROFILE CREATE ----------

company.post('/profile/create', async (c) => {
  try {
    const user = c.get('user');
    const email = user.email;
    const db = c.env.DB;
    const bucket = c.env.R2_BUCKET;

    const formData = await c.req.parseBody();

    const company_logo = await uploadToR2(
      bucket,
      formData['company_logo'],
      'company-logos',
      email.split('@')[0]
    );

    const existing = await db.prepare(
      'SELECT id FROM company_profile WHERE email = ?'
    ).bind(email).first();

    if (existing) {
      await db.prepare(`
        UPDATE company_profile
        SET company_name = ?, company_logo = ?, hr_person_name = ?,
            hr_person_contact = ?, company_website = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE email = ?
      `).bind(
        formData.company_name,
        company_logo || formData.existing_logo || null,
        formData.hr_person_name || null,
        formData.hr_person_contact || null,
        formData.company_website || null,
        email
      ).run();
    } else {
      await db.prepare(`
        INSERT INTO company_profile (
          company_name, email, company_logo,
          hr_person_name, hr_person_contact, company_website
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        formData.company_name,
        email,
        company_logo || null,
        formData.hr_person_name || null,
        formData.hr_person_contact || null,
        formData.company_website || null
      ).run();
    }

    return c.json({
      success: true,
      message: 'Company profile saved successfully.'
    });
  } catch (err) {
    console.error('Company profile creation failed:', err);
    return c.json({
      success: false,
      error: 'Failed to save company profile'
    }, 500);
  }
});

company.post('/profile/update', async (c) => {
  try {
    const user = c.get('user');
    const email = user.email;
    const db = c.env.DB;
    const bucket = c.env.R2_BUCKET;

    const formData = await c.req.parseBody();

    const company_logo = await uploadToR2(
      bucket,
      formData['company_logo'],
      'company-logos',
      email.split('@')[0]
    );

    const existing = await db.prepare(
      'SELECT id FROM company_profile WHERE email = ?'
    ).bind(email).first();

    if (existing) {
      await db.prepare(`
        UPDATE company_profile
        SET company_name = ?, company_logo = ?, hr_person_name = ?,
            hr_person_contact = ?, company_website = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE email = ?
      `).bind(
        formData.company_name,
        company_logo || formData.existing_logo || null,
        formData.hr_person_name || null,
        formData.hr_person_contact || null,
        formData.company_website || null,
        email
      ).run();
    }

    return c.json({
      success: true,
      message: '✅ Company profile saved successfully.'
    });
  } catch (err) {
    console.error('❌ Company profile creation failed:', err);
    return c.json({
      success: false,
      error: '❌ Failed to save company profile',
      details: err.message
    }, 500);
  }
});

// ---------- COMPANY PROFILE VIEW ----------

company.get('/profile/view', async (c) => {
  try {
    const user = c.get('user');
    const email = user.email;
    const db = c.env.DB;

    const profile = await db.prepare(`
      SELECT id, company_name, email, company_logo,
             hr_person_name, hr_person_contact,
             company_website, updated_at
      FROM company_profile
      WHERE email = ?
    `).bind(email).first();

    if (!profile) {
      return c.json({
        success: false,
        message: 'Company profile not found.'
      }, 404);
    }

    return c.json({ success: true, profile });
  } catch (err) {
    console.error('Fetch company profile failed:', err);
    return c.json({
      success: false,
      error: 'Failed to fetch company profile'
    }, 500);
  }
});

// ---------- POST JOB ----------

company.post('/post-job', async (c) => {
  try {
    const formData = await c.req.parseBody();
    const db = c.env.DB;
    const companyUser = c.get('user');
    const company_email = companyUser.email;

    const companyRes = await db.prepare(
      'SELECT id FROM company_profile WHERE email=?'
    ).bind(company_email).first();

    let company_id = companyRes?.id;

    if (!company_id) {
      return c.json({
        success: false,
        message: 'Company not found.'
      }, 404);
    }

    company_id = Number(company_id);

    if (
      !formData.company_title ||
      !formData.deadline_date ||
      !formData.deadline_time
    ) {
      return c.json({
        success: false,
        message: 'company_title, deadline_date and deadline_time are required'
      }, 400);
    }

    // Convert deadline date and time to IST (single column)
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const deadlineUTC = new Date(
      `${formData.deadline_date}T${formData.deadline_time}:00Z`
    );
    const deadlineIST = new Date(deadlineUTC.getTime() + istOffsetMs);
    const deadlineDateTimeIST =
      deadlineIST.toISOString().replace('T', ' ').slice(0, 19);

    const parseJSONField = (field) => {
      if (!field) return '[]';

      if (typeof field === 'string') {
        try {
          return JSON.stringify(JSON.parse(field));
        } catch {
          return JSON.stringify(field);
        }
      }

      return JSON.stringify(field);
    };

    const insertJobPosting = db.prepare(`
      INSERT INTO job_postings (
        company_id,
        job_title,
        company_title,
        job_description,
        industry,
        job_location,
        job_type,
        role_type,
        openings,
        skills_required,
        ctc,
        stipend,
        batch,
        drive_date,
        deadline_date_time,
        interview_mode,
        kt_allowed,
        min_cgpa,
        min_tenth,
        min_twelfth,
        min_diploma,
        eligible_branches,
        selection_rounds,
        perks
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = await insertJobPosting.bind(
      company_id,
      (formData.job_title || '').trim(),
      (formData.company_title || '').trim(),
      (formData.job_description || '').trim(),
      formData.industry || null,
      (formData.jobLocation || '').trim(),
      (formData.jobType || '').trim(),
      formData.roleType || null,
      parseInt(formData.openings) || 0,
      parseJSONField(formData.skills_required || []),
      formData.ctc || null,
      formData.stipend || null,
      (formData.batch || '').trim(),
      formData.driveDate,
      deadlineDateTimeIST,
      (formData.interviewMode || '').trim(),
      formData.ktAllowed || 'No',
      parseFloat(formData.minCGPA) || null,
      parseFloat(formData.minTenth) || null,
      parseFloat(formData.minTwelfth) || null,
      parseFloat(formData.minDiploma) || null,
      parseJSONField(formData.eligibleBranches || []),
      (formData.selectionRounds || '').trim(),
      formData.perks || null
    ).run();

    // ADDED: Notify active students matching the eligible branches.
    // This is a branch-based filter; batch, CGPA and marks are not checked here.
    try {
      const eligibleBranches = JSON.parse(
        parseJSONField(formData.eligibleBranches || [])
      );

      const activeStudents = await db.prepare(`
        SELECT student_id, department
        FROM student_profiles
        WHERE status = 'active'
      `).all();

      const normalizedBranches = Array.isArray(eligibleBranches)
        ? eligibleBranches.map(branch => String(branch).trim().toLowerCase())
        : [];

      const studentIds = (activeStudents.results || [])
        .filter(student => {
          if (normalizedBranches.length === 0) return true;

          const department = String(student.department || '')
            .trim()
            .toLowerCase();

          return normalizedBranches.includes(department);
        })
        .map(student => student.student_id)
        .filter(id => id !== null && id !== undefined)
        .map(String);

      if (studentIds.length > 0) {
        await sendPortalNotification(c.env, {
          type: 'eligible_job_posted',
          studentIds,
          title: 'New Job Opportunity',
          message: `${String(formData.company_title).trim()} has posted a new job opportunity.`,
          link: '/jobs'
        });
      }
    } catch (notificationError) {
      // Do not change the job-posting response if notifications fail.
      console.error(
        'Failed to send new-job notifications:',
        notificationError.message
      );
    }

    return c.json({
      success: true,
      message: 'Job posted successfully',
      job_id: result.lastInsertRowid
    });

  } catch (err) {
    console.error('Job posting failed:', err);
    return c.json({ success: false, message: err }, 500);
  }
});

// ---------- VIEW COMPANY JOBS ----------

company.get('/view-jobs', async (c) => {
  try {
    const db = c.env.DB;
    const companyUser = c.get('user');

    const companyRes = await db.prepare(
      'SELECT id FROM company_profile WHERE email=?'
    ).bind(companyUser.email).first();

    if (!companyRes?.id) {
      return c.json({
        success: false,
        message: 'Company not found.'
      }, 404);
    }

    const jobsResult = await db.prepare(
      'SELECT * FROM job_postings WHERE company_id = ?'
    ).bind(companyRes.id).all();

    const jobs = jobsResult.results.map(job => {
      if (job.skills_required) {
        job.skills_required = JSON.parse(job.skills_required);
      }

      if (job.eligible_branches) {
        job.eligible_branches = JSON.parse(job.eligible_branches);
      }

      return job;
    });

    return c.json({ success: true, jobs });
  } catch (err) {
    console.error('Fetch jobs failed:', err);
    return c.json({ success: false, message: err.message }, 500);
  }
});

// ---------- VIEW APPLICATIONS ----------

company.get('/applications/:job_id', async (c) => {
  const db = c.env.DB;
  const job_id = c.req.param('job_id');

  try {
    const { results } = await db.prepare(`
      SELECT a.*, s.first_name, s.last_name, s.email,
             s.contact_number_primary, s.current_year,
             s.department, s.cgpa
      FROM applications a
      JOIN student_profiles s ON a.student_id = s.student_id
      WHERE a.job_id = ?
    `).bind(job_id).all();

    return c.json({ success: true, applications: results });
  } catch (err) {
    console.error('Error retrieving applications:', err);
    return c.json({ success: false, message: 'Server error.' }, 500);
  }
});

// ---------- UPDATE RESULT ----------

company.post('/result/:job_id', async (c) => {
  try {
    const db = c.env.DB;
    const job_id = parseInt(c.req.param('job_id'), 10);

    if (isNaN(job_id)) {
      return c.json({ success: false, error: 'Invalid job_id' }, 400);
    }

    const body = await c.req.json();
    const selected_students = body.selected_students;

    if (!Array.isArray(selected_students)) {
      return c.json({ success: false, error: 'Invalid request format' }, 400);
    }

    const applicants = await db.prepare(
      'SELECT student_id FROM applications WHERE job_id = ?'
    ).bind(job_id).all();

    const selectedSet = new Set(selected_students);

    // ADDED: Keep separate recipient lists for the two result notifications.
    const selectedStudentIds = [];
    const rejectedStudentIds = [];

    for (const row of applicants.results) {
      const status = selectedSet.has(row.student_id)
        ? 'selected'
        : 'rejected';

      const updateResult = await db.prepare(
        'UPDATE applications SET status = ? WHERE job_id = ? AND student_id = ?'
      ).bind(status, job_id, row.student_id).run();

      // ADDED: Collect recipients only when the update changed a row.
      if ((updateResult.meta?.changes ?? 0) > 0) {
        if (status === 'selected') {
          selectedStudentIds.push(String(row.student_id));
        } else {
          rejectedStudentIds.push(String(row.student_id));
        }
      }
    }

    // ADDED: Retrieve the job title for notification messages.
    const job = await db.prepare(`
      SELECT company_title, job_title
      FROM job_postings
      WHERE id = ?
    `).bind(job_id).first();

    const jobTitle =
      job?.job_title ||
      job?.company_title ||
      'the job you applied for';

    // ADDED: Notify selected students.
    if (selectedStudentIds.length > 0) {
      await sendPortalNotification(c.env, {
        type: 'placement_selected',
        studentIds: selectedStudentIds,
        title: 'Congratulations! You Have Been Selected',
        message: `You have been selected for ${jobTitle}.`,
        link: '/applications'
      });
    }

    // ADDED: Notify students whose applications were rejected.
    if (rejectedStudentIds.length > 0) {
      await sendPortalNotification(c.env, {
        type: 'application_rejected',
        studentIds: rejectedStudentIds,
        title: 'Application Status Updated',
        message: `Your application for ${jobTitle} was not selected.`,
        link: '/applications'
      });
    }

    return c.json({ success: true });
  } catch (err) {
    console.error('Error processing result:', err);
    return c.json({ success: false, error: 'Server error' }, 500);
  }
});

export default company;
