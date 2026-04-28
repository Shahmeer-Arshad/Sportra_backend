import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('🌱 Starting database seed...')

  // Create admin user
  const admin = await prisma.user.upsert({
    where: { email: 'admin@example.com' },
    update: {},
    create: {
      email: 'admin@example.com',
      name: 'Admin User',
      // NOTE: In production, hash the password before storing!
      // Example: bcrypt.hashSync('Admin@1234', 10)
      password: 'hashed_password_here',
      role: 'ADMIN',
    },
  })

  console.log(`✅ Created admin user: ${admin.email}`)
  console.log('✅ Seed completed!')
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
