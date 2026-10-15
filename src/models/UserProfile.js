import mongoose from 'mongoose';

const userProfileSchema = new mongoose.Schema(
  {
    phoneNumber: { type: String, required: true, unique: true, index: true },
    name:        { type: String, default: null },
    email:       { type: String, default: null },
    preferences: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Long-term memory: key facts the agents should remember across calls
    memory: [
      {
        key:       String,
        value:     String,
        updatedAt: { type: Date, default: Date.now },
      },
    ],
    callCount:   { type: Number, default: 0 },
    lastCallAt:  { type: Date, default: null },
  },
  { timestamps: true }
);

userProfileSchema.methods.upsertMemory = function (key, value) {
  const existing = this.memory.find(m => m.key === key);
  if (existing) {
    existing.value = value;
    existing.updatedAt = new Date();
  } else {
    this.memory.push({ key, value });
  }
};

export const UserProfile = mongoose.model('UserProfile', userProfileSchema);
