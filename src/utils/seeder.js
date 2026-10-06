const mongoose = require('mongoose');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');

const User = require('../models/User');
const Course = require('../models/Course');
const StudentProfile = require('../models/StudentProfile');

dotenv.config();

const mockCourses = [
  {
    name: 'Aircraft Maintenance Engineering (AME)',
    code: 'AME-01',
    duration: '3 Years',
    baseFees: 240000,
    description: 'DGCA approved program on mechanical & avionics categories of aircraft structures, jet engines, and electronic control devices.',
  },
  {
    name: 'Aviation Management & Airport Operations',
    code: 'AVM-02',
    duration: '2 Years',
    baseFees: 180000,
    description: 'Comprehensive program covering airport logistics, cargo handling, terminal security, and airline ground resource management.',
  }
];

const seedDatabase = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('MongoDB connected for seeding...');

    // Clear existing data (optional, but good for reset)
    console.log('Clearing old collections (except user admin if present)...');
    await Course.deleteMany({});
    
    // We clear all users to ensure any old corrupted admin accounts are purged
    await User.deleteMany({});
    await StudentProfile.deleteMany({});

    // 1. Seed Courses
    console.log('Seeding courses...');
    const createdCourses = await Course.insertMany(mockCourses);
    console.log(`Successfully seeded ${createdCourses.length} courses!`);

    const courseId = createdCourses[0]._id;

    // 3. Mock accounts payload
    const mockUsers = [
      {
        name: 'Sushil Manager',
        email: 'manager@innovbit.in',
        phone: '9876543210',
        password: 'password123',
        role: 'manager',
        status: 'active'
      },
      {
        name: 'Rahul Counsellor',
        email: 'caller@innovbit.in',
        phone: '9876543211',
        password: 'password123',
        role: 'counsellor',
        status: 'active'
      },
      {
        name: 'Priya Accountant',
        email: 'accountant@innovbit.in',
        phone: '9876543212',
        password: 'password123',
        role: 'accountant',
        status: 'active'
      },
      {
        name: 'Sharma Sir (Teacher)',
        email: 'teacher@innovbit.in',
        phone: '9876543213',
        password: 'password123',
        role: 'teacher',
        status: 'active'
      },
      {
        name: 'Amit Student',
        email: 'student@innovbit.in',
        phone: '9876543214',
        password: 'password123',
        role: 'student',
        status: 'active'
      }
    ];

    console.log('Seeding mock role accounts...');
    const createdUsers = [];
    for (const u of mockUsers) {
      const user = await User.create(u);
      createdUsers.push(user);
    }
    console.log(`Seeded ${createdUsers.length} role accounts!`);

    // Find student user to link profile
    const studentUser = createdUsers.find(u => u.role === 'student');
    
    // Create StudentProfile for student
    console.log('Linking student profile...');
    await StudentProfile.create({
      studentId: `Innovbit/${new Date().getFullYear()}/0001`,
      user: studentUser._id,
      fatherName: 'Ramesh Singh',
      motherName: 'Sunita Devi',
      dob: new Date('2005-08-15'),
      gender: 'Male',
      address: 'Dwarka Sector 8, New Delhi',
      course: courseId,
      entranceStatus: 'pending',
      feeDetails: {
        totalFee: createdCourses[0].baseFees,
        scholarshipAmount: 0,
        netFee: createdCourses[0].baseFees,
        paidFee: 0,
      },
      academicDetails: {
        tenthPercentage: 88.5,
        twelfthPercentage: 82.3,
      }
    });

    console.log('Database seeding successfully completed! All roles ready for login.');
    console.log('Use password "password123" for all seeded mock accounts.');
    process.exit(0);
  } catch (error) {
    console.error('Error seeding database:', error.message);
    process.exit(1);
  }
};

// Run seeder
seedDatabase();
